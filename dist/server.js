import url from 'url';
import path from 'path';
import express from "express";
import Database from 'better-sqlite3';
const db = new Database('foodPlanner.db');
const app = express();
const PORT = 3000;
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename.replace('dist/', ''));
{
    app
        .use(express.json())
        .use(express.static('dist/web/'))
        .use(express.static('public/'))
        .get('/', (rx, tx) => tx.sendFile(path.join(__dirname, 'html/index.html')))
        .get('/groceries', (rx, tx) => tx.sendFile(path.join(__dirname, 'html/groceries.html')))
        .get('/recipes', (rx, tx) => tx.sendFile(path.join(__dirname, 'html/recipes.html')))
        .listen(PORT, () => {
        console.log(`Listening on port ${PORT}`);
    });
}
