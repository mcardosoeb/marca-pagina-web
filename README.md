# Marca Pagina Web

Leitor de livros em PDF para iPhone (PWA) que **sempre lembra a página onde você parou**, gerencia vários livros e funciona **offline** depois de instalado na Tela de Início.

## Como funciona

- Os PDFs são guardados **no próprio iPhone** (IndexedDB). Nada é enviado ao servidor — o Railway só entrega o app.
- A posição exata (página, ponto dentro dela e zoom) é salva enquanto você rola e também quando o app vai para segundo plano/fecha.
- Se você fechar o app no meio de um livro, ele reabre **direto naquele livro e página**.
- Na estante, cada livro mostra capa, progresso e a página onde parou.

### Usando o leitor

| Ação | Gesto |
|---|---|
| Mudar de página | role para baixo / para cima (as páginas ficam em sequência) |
| Zoom | pinça com dois dedos (até 4×); com zoom, arraste para mover |
| Zoom rápido | toque duplo amplia 2× naquele ponto; outro toque duplo volta |
| Mostrar/esconder barras | um toque na página |
| Ir para uma página | arraste a barra ou toque em "13 / 240" e digite |
| Modo noturno | ícone de lua |
| Renomear / remover / zerar marcador | botão ••• na capa do livro |

## Rodar localmente

```bash
npm install
npm start
```

Abra http://localhost:3000.

## Publicar no Railway

1. Crie um repositório no GitHub com esta pasta (o `node_modules` já está no `.gitignore`).
2. No Railway: **New Project → Deploy from GitHub repo** e escolha o repositório.
   O Railway detecta Node, roda `npm install` e `npm start` automaticamente (porta via `PORT`).
3. Em **Settings → Networking → Generate Domain** para obter o endereço `https://...up.railway.app`.

Alternativa sem GitHub, com a CLI do Railway:

```bash
npm i -g @railway/cli
railway login
railway init
railway up
```

## Instalar no iPhone

1. Abra o endereço do Railway no **Safari** (precisa ser o Safari).
2. Toque em **Compartilhar** → **Adicionar à Tela de Início**.
3. Abra pelo ícone "Marca Página". A partir daí funciona sem internet.

> Os livros ficam salvos no app instalado na Tela de Início. Ele tem armazenamento separado do Safari: livros adicionados no Safari não aparecem no app instalado (e vice‑versa). Adicione os livros já pelo ícone.

## Atualizar o app

Ao alterar arquivos em `public/`, aumente `VERSION` em `public/sw.js` (ex.: `mpw-v2`) antes do deploy. O iPhone baixa a nova versão na próxima vez que abrir o app com internet. Seus livros e páginas salvas não são apagados.

## Estrutura

```
server.js                 servidor Express (arquivos estáticos)
public/index.html         telas (estante e leitor)
public/app.js             lógica: armazenamento, estante, leitor, gestos
public/styles.css         visual
public/sw.js              service worker (offline)
public/manifest.webmanifest
public/vendor/pdfjs/      pdf.js 4.10.38 (Mozilla, Apache-2.0) — renderização do PDF
public/icons/             ícones (gerados por `npm run icons`)
```
