const express = require("express");
const multer = require("multer");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();
const mysql = require("mysql2");
const FormData = require("form-data");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const secret = process.env.JWT_SECRET; // Ensure you set this in your environment variables

const app = express();
// Enable CORS for all routes
app.use(cors());
app.use(express.json());

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1]; // Extract the token from "Bearer <token>"

  if (!token) {
    return res.status(401).json({ error: "Access denied. No token provided." });
  }

  jwt.verify(token, secret, (err, user) => {
    if (err) {
      if (err.name === "TokenExpiredError") {
        return res.status(401).json({ error: "Token expired." });
      }
      return res.status(403).json({ error: "Invalid token." });
    }
    req.user = user; // Attach user info to request object
    next();
  });
}


const connection = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// Test the connection to database
connection.connect((err) => {
  if (err) {
    console.error("Error connecting to MySQL:", err);
    return;
  }
  console.log("Connected to MySQL!");
});

// // Fetch all rows ( for testing purpose )
// const fetchQuery = `SELECT * FROM users`;
// connection.query(fetchQuery, (err, results) => {
//     if (err) {
//         console.error('Error fetching data:', err);
//         return;
//     }
//     console.log('Fetched data:', results);
// });

// helps to store the audio file in memory , for faster access
const upload = multer({ storage: multer.memoryStorage() });

app.post("/evaluate", upload.single("audio"), async (req, res) => {
  const { script } = req.body;
  const audioFile = req.file;

  if (!script || !audioFile) {
    return res
      .status(400)
      .json({ error: "Script and audio file are required." });
  }

  // Verify audio MIME type
  if (audioFile.mimetype !== "audio/wav") {
    return res
      .status(400)
      .json({ error: "Only .wav audio files are supported." });
  }

  try {
    console.log("Sending request to FastAPI backend...");
    const formData = new FormData();
    formData.append("file", audioFile.buffer, audioFile.originalname);
    formData.append("script", script);

    const response = await axios.post(
      "http://localhost:8000/evaluate_all",
      formData,
      {
        headers: formData.getHeaders(),
      }
    );

    // Log the response in the terminal
    console.log(
      "Response from Python API:",
      JSON.stringify(response.data, null, 2)
    );

    res.json(response.data);
  } catch (error) {
    console.error("Python API Error Response:", error.response.data);
    return res.status(500).json({ error: error.response.data });
  }
});

app.post("/mock-interview", authenticateToken, upload.single("audio"), async (req, res) => {
  const { type, difficulty } = req.body; // Extract difficulty level
  const audioFile = req.file; // Uploaded audio file
  const userId = req.user.userId;

  try {
    console.log("Fetching conversation history...");
    // Fetch conversation history from the database
    const [history] = await connection.promise().query(
      `SELECT user_message, bot_response FROM conversation_history 
       WHERE user_id = ? ORDER BY timestamp ASC`,
      [userId]
    );

    // Format the history for the Python backend
    const formattedHistory = history
      .map((entry) => `User: ${entry.user_message}\nBot: ${entry.bot_response}`)
      .join("\n");

    console.log("Sending request to Python backend...");

    // Prepare formData for audio, history, and difficulty
    const formData = new FormData();
    formData.append("type", type);
    formData.append("difficulty", difficulty); // Include difficulty level
    formData.append("audio", audioFile.buffer, audioFile.originalname);
    formData.append("history", formattedHistory);

    // Send request to Python backend
    const response = await axios.post("http://localhost:8000/mock-interview", formData, {
      headers: { ...formData.getHeaders() },
    });

    // Log Python API response
    const data = response.data;
    console.log("Response from Python API:", data);

    // Validate required fields
    if (!data.transcription || !data.feedback || !data.follow_up_question) {
      console.warn("Missing required fields:", {
        transcription: data.transcription,
        feedback: data.feedback,
        follow_up_question: data.follow_up_question,
      });
    }

    // Insert into conversation history if valid
    const conversationId = Date.now(); // Generate a unique ID for the conversation
    if (data.transcription && data.feedback && data.follow_up_question) {
      await connection.promise().query(
        `INSERT INTO conversation_history (user_id, conversation_id, user_message, bot_response, timestamp) 
         VALUES (?, ?, ?, ?, NOW())`,
        [userId, conversationId, data.transcription, data.follow_up_question]
      );
    }

    // Send back to the client
    res.json(data);
  } catch (error) {
    console.error("Error in /mock-interview:", error.message || error.response.data);
    res.status(500).json({ error: "Failed to process the interview." });
  }
});





// login , register and get all users
// User Registration
app.post('/register', async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email, and password are required.' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  connection.query(
    'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
    [username, email, hashedPassword],
    (err) => {
      if (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          return res.status(400).json({ error: 'Username or email already exists.' });
        }
        console.error('Error during user registration:', err);
        return res.status(500).json({ error: 'User registration failed' });
      }
      res.json({ message: 'User registered successfully' });
    }
  );
});


// User Login
app.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username/email and password are required.' });
  }

  // Check if the provided value is an email or a username
  const query = username.includes('@')
    ? 'SELECT * FROM users WHERE email = ?'
    : 'SELECT * FROM users WHERE username = ?';

  connection.query(query, [username], async (err, results) => {
    if (err || results.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const user = results[0];
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const token = jwt.sign({ userId: user.id }, secret, { expiresIn: '1h' });
    res.json({ token });
  });
});

app.post("/generate-script", authenticateToken, async (req, res) => {
  const { tone} = req.body;
  console.log("Tone:", tone);
  if (!tone ) {
    return res.status(400).json({ error: "Tone and setting are required." });
  }

  try {
    const response = await axios.post("http://localhost:8000/generate-script", { tone });
    res.json(response.data);
  } catch (error) {
    console.error("Error from Python API:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to generate script." });
  }
});

app.post('/store-history', authenticateToken, async (req, res) => {
  const { userId } = req.user;
  const { conversationId, userMessage, botResponse } = req.body;

  if (!conversationId || !userMessage || !botResponse) {
    console.error('Missing required fields:', req.body);
    return res.status(400).json({ error: 'All fields are required.' });
  }

  connection.query(
    'INSERT INTO conversation_history (user_id, conversation_id, user_message, bot_response) VALUES (?, ?, ?, ?)',
    [userId, conversationId, userMessage, botResponse],
    (err) => {
      if (err) {
        console.error('Error storing history:', err);
        return res.status(500).json({ error: 'Failed to store history.' });
      }
      res.json({ message: 'History stored successfully.' });
    }
  );
});

app.get('/fetch-history', authenticateToken, (req, res) => {
  const { userId } = req.user;
  const { conversationId } = req.query; // Fetch conversation_id from query params

  let query = `
    SELECT conversation_id, user_message, bot_response, timestamp
    FROM conversation_history
    WHERE user_id = ?
      AND timestamp >= NOW() - INTERVAL 15 DAY
  `;
  const params = [userId];

  if (conversationId) {
    query += ` AND conversation_id = ? ORDER BY timestamp ASC`;
    params.push(conversationId);
  } else {
    query = `
      SELECT DISTINCT conversation_id, MAX(timestamp) AS latest_timestamp
      FROM conversation_history
      WHERE user_id = ?
        AND timestamp >= NOW() - INTERVAL 15 DAY
      GROUP BY conversation_id
      ORDER BY latest_timestamp DESC
    `;
  }

  connection.query(query, params, (err, results) => {
    if (err) {
      console.error('Error fetching conversation history:', err);
      return res.status(500).json({ error: 'Failed to fetch history.' });
    }
    res.json({ history: results });
  });
});



app.listen(3000, () => {
  console.log("Node.js backend running on http://localhost:3000");
});

