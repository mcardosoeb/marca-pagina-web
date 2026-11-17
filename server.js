// Servidor estático do Marca Pagina Web (para o Railway).
// Os livros NÃO são enviados ao servidor: ficam guardados no próprio iPhone (IndexedDB).
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");

app.disable("x-powered-by");

// O Railway termina o HTTPS no proxy; redireciona HTTP -> HTTPS (PWA exige HTTPS).
app.enable("trust proxy");
app.use((req, res, next) => {
  if (process.env.RAILWAY_ENVIRONMENT && req.headers["x-forwarded-proto"] === "http") {
    return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  }
  next();
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.use(
  express.static(PUBLIC, {
    setHeaders(res, filePath) {
      const name = path.basename(filePath);
      if (name === "sw.js" || name.endsWith(".html") || name.endsWith(".webmanifest")) {
        // Sempre buscar a versão mais nova do service worker / página / manifesto.
        res.setHeader("Cache-Control", "no-cache");
      } else {
        res.setHeader("Cache-Control", "public, max-age=3600");
      }
      if (name.endsWith(".mjs")) res.setHeader("Content-Type", "text/javascript; charset=utf-8");
      if (name.endsWith(".webmanifest")) res.setHeader("Content-Type", "application/manifest+json");
    },
  })
);

// Qualquer outra rota cai no app.
app.get("*", (req, res) => res.sendFile(path.join(PUBLIC, "index.html")));

app.listen(PORT, () => console.log(`Marca Pagina Web rodando na porta ${PORT}`));
