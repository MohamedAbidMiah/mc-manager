const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(express.json());

// --- PASSWORD PROTECTION MIDDLEWARE ---
const MC_ADMIN_USER = process.env.MC_ADMIN_USER;
const MC_ADMIN_PASSWORD = process.env.MC_ADMIN_PASSWORD;

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Minecraft World Manager"');
    return res.status(401).send("Authentication required.");
  }

  try {
    const [user, pass] = Buffer.from(authHeader.split(" ")[1], "base64")
      .toString()
      .split(":");

    if (user === MC_ADMIN_USER && pass === MC_ADMIN_PASSWORD) {
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

const getServerConfig = (serverName) => {
  return {
    worldDir: path.join(BASE_DATA_DIR, serverName, "world"),
    containerName: `mc-${serverName}`,
  };
};

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

// 2. Download World
app.get("/api/download/:server", (req, res) => {
  const { worldDir } = getServerConfig(req.params.server);
  if (!fs.existsSync(worldDir))
    return res.status(404).send("World directory not found.");

  try {
    const zip = new AdmZip();
    zip.addLocalFolder(worldDir);
    const buffer = zip.toBuffer();

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${req.params.server}-world.zip"`,
    );
    res.send(buffer);
  } catch (err) {
    res.status(500).send("Failed to create zip archive.");
  }
});

// 3. Upload World
app.post("/api/upload/:server", upload.single("world"), (req, res) => {
  const serverName = req.params.server;
  const { worldDir, containerName } = getServerConfig(serverName);

  if (!req.file) return res.status(400).send("No file uploaded.");
  const zipPath = req.file.path;

  try {
    exec(`docker stop ${containerName}`, () => {
      const zip = new AdmZip(zipPath);
      if (fs.existsSync(worldDir)) {
        fs.rmSync(worldDir, { recursive: true, force: true });
      }
      fs.mkdirSync(worldDir, { recursive: true });
      zip.extractAllTo(worldDir, true);
      fs.unlinkSync(zipPath);

      exec(`docker start ${containerName}`, () => {
        res.send(
          `World uploaded and server ${serverName} restarted successfully!`,
        );
      });
    });
  } catch (err) {
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    res.status(500).send("Failed to process the uploaded world zip.");
  }
});

// 4. Start / Stop Container
app.post("/api/container/:server/:action", (req, res) => {
  const { server, action } = req.params;
  if (action !== "start" && action !== "stop") {
    return res.status(400).send("Invalid action.");
  }

  const { containerName } = getServerConfig(server);

  exec(`docker ${action} ${containerName}`, (err, stdout, stderr) => {
    if (err)
      return res.status(500).send(`Failed to ${action} container: ${stderr}`);
    res.send(`Container ${containerName} successfully ${action}ped.`);
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MC World Manager running on port ${PORT}`);
});
