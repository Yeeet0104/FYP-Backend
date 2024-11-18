const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { exec } = require('child_process');
const app = express();

app.use(cors());
app.use(bodyParser.json());

// API endpoint for processing audio
app.post('/process-audio', (req, res) => {
    const filePath = req.body.filePath;

    // Call the Python script for processing
    exec(`python process_audio.py ${filePath}`, (err, stdout, stderr) => {
        if (err) {
            return res.status(500).send({ error: stderr });
        }
        res.send({ result: stdout });
    });
});

// Example API endpoint
app.get("/api/data", (req, res) => {
    res.json({ message: "Hello from the backend!" });
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
