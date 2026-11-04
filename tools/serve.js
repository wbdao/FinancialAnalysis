// A small static server for previewing the site locally: node tools/serve.js
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const PORT = 8321;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

http.createServer((req, res) => {
  let name;
  try {
    name = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    res.writeHead(400).end();
    return;
  }
  // Never serve dotfiles (.git, .claude) from the preview server.
  if (name.split(/[\\/]/).some((part) => part.startsWith('.'))) {
    res.writeHead(403).end();
    return;
  }
  const file = path.join(ROOT, name === '/' ? 'index.html' : name);
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': `${TYPES[path.extname(file)] || 'application/octet-stream'}; charset=utf-8` });
    res.end(body);
  });
}).listen(PORT, HOST, () => console.log(`http://${HOST}:${PORT}`));
