const express = require("express");
const multer = require("multer");
const unzipper = require("unzipper");
const archiver = require("archiver");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { pipeline } = require("stream/promises");

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(express.json());

// --- PASSWORD PROTECTION MIDDLEWARE ---
const MC_ADMIN_USER = process.env.MC_ADMIN_USER;
const MC_ADMIN_PASSWORD = process.env.MC_ADMIN_PASSWORD;

const safeEqual = (a, b) => {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Minecraft World Manager"');
    return res.status(401).send("Authentication required.");
  }

  try {
    const decoded = Buffer.from(authHeader.split(" ")[1], "base64").toString();
    const idx = decoded.indexOf(":");
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);

    if (
      MC_ADMIN_USER &&
      MC_ADMIN_PASSWORD &&
      safeEqual(user, MC_ADMIN_USER) &&
      safeEqual(pass, MC_ADMIN_PASSWORD)
    ) {
      return next();
    }
  } catch (err) {
    // malformed header fallback
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Minecraft World Manager"');
  res.status(401).send("Invalid username or password.");
};

// Protect ALL routes with the password
app.use(authMiddleware);

// --- STATIC FRONTEND & API ROUTES ---
app.use(express.static("public"));

const BASE_DATA_DIR = "/data";

// Only allow simple names, so nothing can escape /data or inject into commands
const SERVER_NAME_RE = /^[a-zA-Z0-9_-]+$/;

const validateServer = (req, res, next) => {
  const name = req.params.server;
  if (!SERVER_NAME_RE.test(name)) {
    return res.status(400).send("Invalid server name.");
  }
  if (!fs.existsSync(path.join(BASE_DATA_DIR, name))) {
    return res.status(404).send("Server not found.");
  }
  next();
};

const getServerConfig = (serverName) => ({
  worldDir: path.join(BASE_DATA_DIR, serverName, "world"),
  backupDir: path.join(BASE_DATA_DIR, serverName, "world.bak"),
  containerName: `mc-${serverName}`,
});

const docker = (action, containerName) =>
  new Promise((resolve, reject) => {
    execFile("docker", [action, containerName], (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });

// 1. List available servers
app.get("/api/servers", (req, res) => {
  try {
    if (!fs.existsSync(BASE_DATA_DIR)) return res.json([]);
    const servers = fs
      .readdirSync(BASE_DATA_DIR, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);
    res.json(servers);
  } catch (err) {
    res.status(500).json({ error: "Failed to list servers" });
  }
});

// 2. Download World (streamed, no size limit)
app.get("/api/download/:server", validateServer, (req, res) => {
  const { worldDir } = getServerConfig(req.params.server);
  if (!fs.existsSync(worldDir))
    return res.status(404).send("World directory not found.");

  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${req.params.server}-world.zip"`,
  );

  // level 1 = fast; world files (.mca) are already compressed internally
  const archive = archiver("zip", { zlib: { level: 1 } });
  archive.on("error", (err) => {
    console.error("Zip error:", err);
    res.destroy(err);
  });
  archive.pipe(res);
  archive.directory(worldDir, false);
  archive.finalize();
});

// 3. Upload World (streamed extraction, no size limit)
app.post(
  "/api/upload/:server",
  validateServer,
  upload.single("world"),
  async (req, res) => {
    const serverName = req.params.server;
    const { worldDir, backupDir, containerName } = getServerConfig(serverName);

    if (!req.file) return res.status(400).send("No file uploaded.");
    const zipPath = req.file.path;

    let hadBackup = false;

    try {
      // Stop the server (ignore error if it's already stopped)
      await docker("stop", containerName).catch(() => {});

      // Keep the old world as a backup until extraction succeeds
      if (fs.existsSync(backupDir)) {
        fs.rmSync(backupDir, { recursive: true, force: true });
      }
      if (fs.existsSync(worldDir)) {
        fs.renameSync(worldDir, backupDir);
        hadBackup = true;
      }

      fs.mkdirSync(worldDir, { recursive: true });

      await pipeline(
        fs.createReadStream(zipPath),
        unzipper.Extract({ path: worldDir }),
      );

      // Success: remove temp upload and old backup
      fs.unlinkSync(zipPath);
      if (hadBackup) {
        fs.rmSync(backupDir, { recursive: true, force: true });
      }

      await docker("start", containerName);
      res.send(
        `World uploaded and server ${serverName} restarted successfully!`,
      );
    } catch (err) {
      console.error("Upload failed:", err);

      // Roll back to the old world
      try {
        if (fs.existsSync(worldDir)) {
          fs.rmSync(worldDir, { recursive: true, force: true });
        }
        if (hadBackup && fs.existsSync(backupDir)) {
          fs.renameSync(backupDir, worldDir);
        }
        await docker("start", containerName).catch(() => {});
      } catch (rollbackErr) {
        console.error("Rollback failed:", rollbackErr);
      }

      if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      res
        .status(500)
        .send("Failed to process the uploaded world zip. Old world restored.");
    }
  },
);

// 4. Start / Stop Container
app.post("/api/container/:server/:action", validateServer, async (req, res) => {
  const { server, action } = req.params;
  if (action !== "start" && action !== "stop") {
    return res.status(400).send("Invalid action.");
  }

  const { containerName } = getServerConfig(server);

  try {
    await docker(action, containerName);
    res.send(`Container ${containerName} successfully ${action}ped.`);
  } catch (err) {
    res.status(500).send(`Failed to ${action} container: ${err.message}`);
  }
});

const PORT = process.env.PORT || 3000;
const httpServer = app.listen(PORT, () => {
  console.log(`MC World Manager running on port ${PORT}`);
});

// Don't time out large uploads/downloads
httpServer.requestTimeout = 0;
httpServer.headersTimeout = 60000;
httpServer.timeout = 0;
