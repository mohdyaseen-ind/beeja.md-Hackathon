import express from "express";
const app = express();
try { app.get("*splat", (req, res) => res.send("splat!")); } catch(e) { console.error("splat failed:", e.message); }
try { app.get("/(.*)", (req, res) => res.send("regex!")); } catch(e) { console.error("regex failed:", e.message); }
console.log("Done");
