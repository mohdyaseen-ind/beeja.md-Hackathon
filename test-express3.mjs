import express from "express";
import http from "http";
const app = express();
app.get("*splat", (req, res) => res.send("splat!"));
const server = http.createServer(app);
server.listen(3001, () => {
  http.get("http://localhost:3001/hello", res => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => console.log('/hello ->', data));
    server.close();
  });
});
