#!/usr/bin/env node
// Universal VSIX packer (no vsce required). 道法自然 — 以最小依赖产出标准 VSIX。
// Usage: node pack-vsix.js <pluginDir> [outVsixPath]
const fs = require("fs");
const path = require("path");
const yazl = require(path.join(__dirname, "..", "plugins", "dao-vsix", "node_modules", "yazl"));

const pluginDir = path.resolve(process.argv[2]);
const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"));
const outVsix = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(pluginDir, `${pkg.name}-${pkg.version}.vsix`);

const CT = {
  ".js": "application/javascript", ".json": "application/json", ".md": "text/markdown",
  ".svg": "image/svg+xml", ".png": "image/png", ".ts": "application/typescript",
  ".map": "application/json", ".txt": "text/plain", ".html": "text/html", ".css": "text/css",
  ".vsixmanifest": "text/xml",
};

const EXCLUDE_DIRS = new Set(["node_modules", ".git"]);
const EXCLUDE_FILES = new Set([".vscodeignore", ".gitignore", "package-lock.json"]);

function walk(dir, base, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (EXCLUDE_DIRS.has(ent.name)) continue;
      walk(path.join(dir, ent.name), base, out);
    } else {
      const rel = path.relative(base, path.join(dir, ent.name)).split(path.sep).join("/");
      if (EXCLUDE_FILES.has(ent.name)) continue;
      if (ent.name.endsWith(".vsix")) continue;
      out.push(rel);
    }
  }
}

const files = [];
walk(pluginDir, pluginDir, files);

// readme asset
const readme = files.find((f) => /^readme\.md$/i.test(f));
const icon = pkg.icon && files.includes(pkg.icon) ? pkg.icon : null;

const exts = new Set(files.map((f) => path.extname(f).toLowerCase()).filter(Boolean));
exts.add(".vsixmanifest");
const contentTypes =
  '<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  [...exts].map((e) => `<Default Extension="${e}" ContentType="${CT[e] || "application/octet-stream"}"/>`).join("") +
  "</Types>";

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const engine = (pkg.engines && pkg.engines.vscode) || "^1.80.0";
const assets = [
  `<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />`,
];
if (readme) assets.push(`<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/${readme}" Addressable="true" />`);
if (icon) assets.push(`<Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${icon}" Addressable="true" />`);

const manifest =
`<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(pkg.version)}" Publisher="${esc(pkg.publisher || "dao")}" />
    <DisplayName>${esc(pkg.displayName || pkg.name)}</DisplayName>
    <Description xml:space="preserve">${esc(pkg.description)}</Description>
    <Tags></Tags>
    <Categories>${esc((pkg.categories || ["Other"]).join(","))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(engine)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free"/>
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    ${assets.join("\n    ")}
  </Assets>
</PackageManifest>`;

const zip = new yazl.ZipFile();
for (const rel of files) zip.addFile(path.join(pluginDir, rel), "extension/" + rel);
zip.addBuffer(Buffer.from(manifest, "utf8"), "extension.vsixmanifest");
zip.addBuffer(Buffer.from(contentTypes, "utf8"), "[Content_Types].xml");
zip.end();
zip.outputStream.pipe(fs.createWriteStream(outVsix)).on("close", () => {
  console.log(`Packed ${path.basename(outVsix)} (${fs.statSync(outVsix).size} bytes, ${files.length} files)`);
});
