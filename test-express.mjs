import express from "express";
const app = express();
app.get("*splat", (req, res) => res.send("splat!"));
app.get("*", (req, res) => res.send("star!"));
app.get("/(.*)", (req, res) => res.send("regex!"));
console.log("Routes registered");
