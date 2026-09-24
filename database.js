const fs = require("fs");
const path = require("path");

const DB_FILE = path.join(__dirname, "atomscape-data.json");

function createDatabase() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(
            DB_FILE,
            JSON.stringify({
                users: [],
                groups: [],
                messages: []
            }, null, 2)
        );
    }
}

function loadDatabase() {
    createDatabase();

    try {
        return JSON.parse(
            fs.readFileSync(DB_FILE, "utf8")
        );
    } catch (error) {
        console.error("Database read error:", error);

        return {
            users: [],
            groups: [],
            messages: []
        };
    }
}

function saveDatabase(data) {
    fs.writeFileSync(
        DB_FILE,
        JSON.stringify(data, null, 2)
    );
}

module.exports = {
    loadDatabase,
    saveDatabase
};