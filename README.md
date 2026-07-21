# Ai33.Pro MCP Server

Ye server aapke Ai33.Pro text-to-speech API ko Claude ke liye ek "tool" bana deta hai. Deploy karne ke baad Claude.ai mein connect karke, aap chat mein bol sakte ho "isko speech mein convert karo" aur Claude khud is API ko call karega.

## 1. Deploy karo (Render.com free tier — sabse aasan)

1. [render.com](https://render.com) pe free account banao.
2. Ye poora `ai33-mcp-server` folder ek GitHub repo mein push karo (ya Render pe seedha "Upload" option use karo agar available ho).
3. Render pe **New + → Web Service** choose karo, apna repo select karo.
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. **Environment → Add Environment Variable:**
   - Key: `AI33_API_KEY`
   - Value: *(apni Ai33.Pro API key yahan paste karo — kabhi code mein mat likhna)*
6. Deploy karo. Kuch minute mein aapko ek public URL milega, jaisे:
   `https://ai33-mcp-server.onrender.com`

Aapka MCP endpoint hoga:
`https://ai33-mcp-server.onrender.com/mcp`

> Alternative hosting: Railway.app, Fly.io, ya Cloudflare Workers — sab pe process same hai, bas har jagah environment variable set karna zaroori hai.

## 2. Claude.ai mein connect karo

1. Claude.ai kholo → profile icon → **Settings → Connectors**
2. **"+" → Add custom connector**
3. **Remote MCP server URL** mein daalo: `https://ai33-mcp-server.onrender.com/mcp`
4. "Add" click karo. Koi OAuth login nahi maangega kyunki auth server ke andar (env variable se) already ho raha hai.
5. Kisi bhi naye chat mein "+" button → Connectors → is connector ko enable karo.
6. Ab bol sakte ho: *"Isko Hindi mein speech mein convert karo: Namaste duniya"* — Claude khud `text_to_speech` tool call karega.

## Local testing (optional)

```bash
npm install
AI33_API_KEY=your_key_here npm start
```

Server `http://localhost:3000/mcp` pe chalega.

## Security note

- API key kabhi bhi code mein hardcode mat karna — hamesha environment variable se aayegi.
- Ye server sirf `text_to_speech` tool expose karta hai. Agar image generation (Imagen) bhi chahiye, isi pattern mein ek naya tool add kiya ja sakta hai — bas poochh lena.
