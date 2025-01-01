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
const refreshSecret = process.env.JWT_REFRESH_SECRET; // Secret key for refresh tokens
const fs = require('fs');
const path = require('path');


const app = express();
// Enable CORS for all routes
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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

app.post(
  "/mock-interview",
  authenticateToken,
  upload.single("audio"),
  async (req, res) => {
    const { type, difficulty, conversationId, jobDescription, name } =
      req.body; // Extract conversationId
    const audioFile = req.file;
    const userId = req.user.userId;
    console.log("Request body:", req.body);
    try {
      console.log("Fetching conversation history...");
      let formattedHistory = "";

      if (conversationId) {
        // Fetch history for the existing conversation
        const [history] = await connection.promise().query(
          `SELECT user_message, bot_response 
             FROM conversation_history 
             WHERE user_id = ? AND conversation_id = ? ORDER BY timestamp ASC`,
          [userId, conversationId]
        );

        formattedHistory = history
          .map(
            (entry) => `User: ${entry.user_message}\nBot: ${entry.bot_response}`
          )
          .join("\n");
      }
      console.log("Formatted history:", formattedHistory);
      console.log("Sending request to Python backend...");

      // Prepare formData for audio, history, and difficulty
      const formData = new FormData();
      formData.append("type", type);
      formData.append("difficulty", difficulty); // Include difficulty level
      formData.append("audio", audioFile.buffer, audioFile.originalname);
      formData.append("history", formattedHistory);
      formData.append("jobDescription", jobDescription || ""); // Pass as empty string if not provided

      // Send request to Python backend
      const response = await axios.post(
        "http://localhost:8000/mock-interview",
        formData,
        {
          headers: { ...formData.getHeaders() },
        }
      );

      // Log Python API response
      const data = response.data;
      console.log("Response from Python API:", data);

      // Validate required fields
      if (
        !data.transcription ||
        !data.feedback ||
        !data.grammar ||
        !data.follow_up_question
      ) {
        console.warn("Missing required fields:", data);
        return res
          .status(400)
          .json({ error: "Incomplete response from Python backend." });
      }

      // Insert into conversation history if valid
      const newConversationId = conversationId || Date.now();
      if (data.transcription && data.feedback && data.follow_up_question) {
        await connection.promise().query(
          `INSERT INTO conversation_history 
           (user_id, conversation_id, user_message, bot_response, feedback, grammar_feedback, name, job_description, timestamp , difficulty) 
           VALUES (?, ?, ?, ?, ?, ?, ?,?, NOW(), ?)`,
          [
            userId,
            newConversationId,
            data.transcription,
            data.follow_up_question,
            data.feedback,
            data.grammar,
            name || null, // Save the name if provided
            jobDescription || null, // Save Job Description
            difficulty || easy,
          ]
        );
      }

      // Send back to the client
      res.json(data);
    } catch (error) {
      console.error(
        "Error in /mock-interview:",
        error.message || error.response.data
      );
      res.status(500).json({ error: "Failed to process the interview." });
    }
  }
);
app.delete("/conversation/:conversationId", authenticateToken, (req, res) => {
  const { conversationId } = req.params;
  const { userId } = req.user;
  console.log("Deleting conversation:", conversationId);
  connection.query(
      "DELETE FROM conversation_history WHERE conversation_id = ? AND user_id = ?",
      [conversationId, userId],
      (err, results) => {
          if (err) {
              console.error("Error deleting conversation:", err);
              return res.status(500).json({ error: "Failed to delete conversation." });
          }
          res.json({ message: "Conversation deleted successfully." });
      }
  );
});

app.get("/get-audio/:filename", async (req, res) => {
  const { filename } = req.params;

  try {
    // Call the Python FastAPI backend to get the audio
    const response = await axios.get(
      `http://localhost:8000/get-audio/${filename}`,
      {
        responseType: "stream", // Important: Ensure the response is treated as a stream
      }
    );

    // Forward the audio stream back to the frontend
    res.setHeader("Content-Type", "audio/wav");
    response.data.pipe(res);
  } catch (error) {
    console.error("Error fetching audio:", error.message);
    res.status(500).json({ error: "Failed to fetch audio file." });
  }
});

// login , register and get all users
// User Registration
app.post("/register", async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res
      .status(400)
      .json({ error: "Username, email, and password are required." });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  connection.query(
    "INSERT INTO users (username, email, password) VALUES (?, ?, ?)",
    [username, email, hashedPassword],
    (err) => {
      if (err) {
        if (err.code === "ER_DUP_ENTRY") {
          return res
            .status(400)
            .json({ error: "Username or email already exists." });
        }
        console.error("Error during user registration:", err);
        return res.status(500).json({ error: "User registration failed" });
      }
      res.json({ message: "User registered successfully" });
    }
  );
});
// Helper function to generate tokens
function generateTokens(userId) {
  const accessToken = jwt.sign({ userId }, secret, { expiresIn: "30m" }); // Short-lived access token
  const refreshToken = jwt.sign({ userId }, refreshSecret, { expiresIn: "7d" }); // Longer-lived refresh token
  return { accessToken, refreshToken };
}
// User Login
app.post("/login", (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res
      .status(400)
      .json({ error: "Username/email and password are required." });
  }

  // Check if the provided value is an email or a username
  const query = username.includes("@")
    ? "SELECT * FROM users WHERE email = ?"
    : "SELECT * FROM users WHERE username = ?";

  connection.query(query, [username], async (err, results) => {
    if (err || results.length === 0) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    const user = results[0];
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    // Generate tokens
    const accessToken = jwt.sign({ userId: user.id }, secret, {
      expiresIn: "3d",
    });
    const refreshToken = jwt.sign({ userId: user.id }, refreshSecret, {
      expiresIn: "7d",
    });

    // Store refresh token in the database
    connection.query(
      "UPDATE users SET refresh_token = ? WHERE id = ?",
      [refreshToken, user.id],
      (err) => {
        if (err) console.error("Error storing refresh token:", err);
      }
    );

    // Send tokens (refresh token as HttpOnly cookie)
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: false, // Use true in production with HTTPS
      sameSite: "Strict",
    });
    res.json({ accessToken });
  });
});

app.post("/refresh-token", (req, res) => {
  const refreshToken = req.cookies.refreshToken; // Extract from cookie

  if (!refreshToken) {
    return res.status(401).json({ error: "Refresh token is required." });
  }

  connection.query(
    "SELECT * FROM users WHERE refresh_token = ?",
    [refreshToken],
    (err, results) => {
      if (err || results.length === 0) {
        return res
          .status(403)
          .json({ error: "Invalid or expired refresh token." });
      }

      const user = results[0];
      jwt.verify(refreshToken, refreshSecret, (err) => {
        if (err) {
          return res
            .status(403)
            .json({ error: "Invalid or expired refresh token." });
        }

        // Generate a new access token
        const newAccessToken = jwt.sign({ userId: user.id }, secret, {
          expiresIn: "30m",
        });
        res.json({ accessToken: newAccessToken });
      });
    }
  );
});

app.post("/logout", authenticateToken, (req, res) => {
  const { userId } = req.user;

  connection.query(
    "UPDATE users SET refresh_token = NULL WHERE id = ?",
    [userId],
    (err) => {
      if (err) {
        console.error("Error revoking refresh token:", err);
        return res.status(500).json({ error: "Failed to log out." });
      }
      // Clear the refresh token cookie
      res.clearCookie("refreshToken", {
        httpOnly: true,
        secure: false, // Use true in production with HTTPS
        sameSite: "Strict",
      });
      res.json({ message: "Logged out successfully." });
    }
  );
});

app.post(
  "/generate-script",
  authenticateToken,
  upload.none(),
  async (req, res) => {
    const { tone, difficulty } = req.body;
    console.log("Tone:", tone);
    console.log("DIff:", difficulty);
    if (!tone) {
      return res.status(400).json({ error: "Tone and setting are required." });
    }

    try {
      // Forward the 'tone' to FastAPI backend
      const formData = new FormData();
      formData.append("tone", tone);
      formData.append("difficulty", difficulty);

      const response = await axios.post(
        "http://localhost:8000/generate-script",
        formData,
        {
          headers: formData.getHeaders(),
        }
      );
      res.json(response.data);
    } catch (error) {
      console.error(
        "Error from Python API:",
        error.response?.data || error.message
      );
      res.status(500).json({ error: "Failed to generate script." });
    }
  }
);

app.post("/store-history", authenticateToken, async (req, res) => {
  const { userId } = req.user;
  const { conversationId, userMessage, botResponse } = req.body;
  console.log("Request body:", req.body);
  if (!conversationId || !userMessage || !botResponse) {
    console.error("Missing required fields:", req.body);
    return res.status(400).json({ error: "All fields are required." });
  }

  connection.query(
    "INSERT INTO conversation_history (user_id, conversation_id, user_message, bot_response) VALUES (?, ?, ?, ?)",
    [userId, conversationId, userMessage, botResponse],
    (err) => {
      if (err) {
        console.error("Error storing history:", err);
        return res.status(500).json({ error: "Failed to store history." });
      }
      res.json({ message: "History stored successfully." });
    }
  );
});

app.get("/fetch-history", authenticateToken, (req, res) => {
  const { userId } = req.user;
  const { conversationId } = req.query; // Fetch conversation_id from query params

  let query = `
    SELECT conversation_id, user_message, bot_response, timestamp ,feedback , grammar_feedback , name
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
          SELECT ch.conversation_id, MAX(ch.timestamp) AS latest_timestamp, 
                (SELECT name 
                  FROM conversation_history 
                  WHERE conversation_id = ch.conversation_id 
                  ORDER BY timestamp DESC LIMIT 1) AS name
          FROM conversation_history ch
          WHERE ch.user_id = 1
            AND ch.timestamp >= NOW() - INTERVAL 15 DAY
          GROUP BY ch.conversation_id
          ORDER BY latest_timestamp DESC;
    `;
  }

  connection.query(query, params, (err, results) => {
    if (err) {
      console.error("Error fetching conversation history:", err);
      return res.status(500).json({ error: "Failed to fetch history." });
    }
    res.json({ history: results });
  });
});


app.post('/upload', upload.single('file'), async (req, res) => {
  const filePath = req.file.path;
  const numQuestions = req.body.numQuestions;
  const bloomLevel = req.body.bloomLevel;
  const questionType = req.body.questionType;
  const includeUseCase = req.body.includeUseCase;

  try {
    // Read the PDF file
    const pdfBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(pdfBuffer);
    const lectureText = data.text;


    const response = await axios.post('http://localhost:8000/generate-questions', {
      lecture_text: lectureText,
      bloom_level: bloomLevel,
      question_type: questionType,
      num_questions: numQuestions,
      include_use_case: includeUseCase
    });

  } catch (error) {
    console.error("Error generating questions:", error);
    res.status(500).send("Error generating questions");
  } finally {
    // Optionally delete the file after processing
    fs.unlink(filePath, (err) => {
      if (err) console.error(`Error deleting file: ${err}`);
    });
  }
});

// New endpoint for grammar checking
app.post("/check-grammar", async (req, res) => {
  const { userAnswerFile1 } = req.body;

  if (!userAnswerFile1 || typeof userAnswerFile1 !== "string") {
    return res.status(400).json({ error: "Invalid answer provided" });
  }

  console.log("Request body received:", req.body);

  try {
    const response = await axios.post(
      "http://localhost:8001/check-grammar",
      {
        userAnswerFile1: req.body.userAnswerFile1,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
    

    console.log("Grammar check feedback:", response.data);
    res.json(response.data);
  } catch (error) {
    console.error(
      "Error checking grammar:",
      error.response?.data || error.message
    );
    res.status(500).json({
      error: "Error checking grammar",
      details: error.response?.data || error.message,
    });
  }
});

app.post("/folders", authenticateToken, (req, res) => {
  const { name } = req.body;
  const userId = req.user.userId;

  connection.query(
    "INSERT INTO folders (name, user_id) VALUES (?, ?)",
    [name, userId],
    (err, result) => {
      if (err)
        return res.status(500).json({ error: "Failed to create folder" });
      res.json({ id: result.insertId, name });
    }
  );
});

// Fetch all folders
app.get("/folders", authenticateToken, (req, res) => {
  const userId = req.user.userId;

  connection.query(
    "SELECT * FROM folders WHERE user_id = ?",
    [userId],
    (err, results) => {
      if (err)
        return res.status(500).json({ error: "Failed to fetch folders" });
      res.json(results);
    }
  );
});
// delete folders
app.delete("/folders/:folderId", authenticateToken, (req, res) => {
  const { folderId } = req.params;

  console.log(`Deleting chapters for folder ID: ${folderId}`);

  // Delete related chapters first
  connection.query(
    "DELETE FROM chapters WHERE folder_id = ?",
    [folderId],
    (err) => {
      if (err) {
        console.error("Error deleting related chapters:", err);
        return res
          .status(500)
          .json({ error: "Failed to delete related chapters" });
      }

      console.log(`Chapters for folder ID ${folderId} deleted.`);

      // Proceed to delete the folder
      connection.query(
        "DELETE FROM folders WHERE id = ?",
        [folderId],
        (err) => {
          if (err) {
            console.error(`Error deleting folder ID ${folderId}:`, err);
            return res.status(500).json({ error: "Failed to delete folder" });
          }

          console.log(`Folder ID ${folderId} deleted successfully.`);
          res.json({
            message: "Folder and related chapters deleted successfully",
          });
        }
      );
    }
  );
});

// edit
app.put("/folders/:folderId", authenticateToken, (req, res) => {
  const { folderId } = req.params;
  const { name } = req.body;

  connection.query(
    "UPDATE folders SET name = ? WHERE id = ?",
    [name, folderId],
    (err) => {
      if (err)
        return res.status(500).json({ error: "Failed to update folder" });
      res.json({ message: "Folder updated successfully" });
    }
  );
});
// chapters
app.post(
  "/chapters",
  authenticateToken,
  upload.single("file"),
  async (req, res) => {
    const { folderId, name } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: "PDF file is required." });
    }

    try {
      // Forward file to Python API for tree generation
      const formData = new FormData();
      formData.append("file", file.buffer, file.originalname);

      const pythonResponse = await axios.post(
        "http://localhost:8000/generate-tree",
        formData,
        { headers: formData.getHeaders() }
      );
      console.log("Python response:", pythonResponse.data.treeData);
      const treeDataRaw = JSON.stringify(
        pythonResponse.data.tree_data,
        null,
        0
      ); // Minified version
      const treeData =
        typeof treeDataRaw === "string"
          ? JSON.stringify(JSON.parse(treeDataRaw), null, 0)
          : JSON.stringify(treeDataRaw, null, 0);
      console.log("Tree data:", treeData);
      connection.query(
        "INSERT INTO chapters (folder_id, name, tree_data) VALUES (?, ?, ?)",
        [folderId, name, treeData], // Pass serialized JSON
        (err, result) => {
          if (err) {
            console.error("Error saving chapter:", err);
            return res.status(500).json({ error: "Failed to add chapter" });
          }
          res.json({
            chapterId: result.insertId,
            name,
            treeData: JSON.parse(treeData),
          }); // Send parsed JSON back
        }
      );
    } catch (error) {
      console.error(
        "Error generating tree:",
        error.response?.data || error.message
      );
      res.status(500).json({ error: "Failed to generate tree diagram." });
    }
  }
);
//Get Chapters for a Folder
app.get("/folders/:folderId/chapters", authenticateToken, (req, res) => {
  const { folderId } = req.params;

  connection.query(
    "SELECT * FROM chapters WHERE folder_id = ?",
    [folderId],
    (err, results) => {
      if (err)
        return res.status(500).json({ error: "Failed to fetch chapters" });
      res.json(results);
    }
  );
});
// chapter details
app.get("/folders/:folderId/chapters", authenticateToken, (req, res) => {
  const { folderId } = req.params;

  connection.query(
    "SELECT * FROM chapters WHERE folder_id = ?",
    [folderId],
    (err, results) => {
      if (err) {
        console.error("Error fetching chapters:", err);
        return res.status(500).json({ error: "Failed to fetch chapters" });
      }

      console.log("Fetched Chapters:", results); // Log the fetched chapters
      res.json(results);
    }
  );
});

// update tree
app.put("/chapters/:chapterId", authenticateToken, (req, res) => {
  const { chapterId } = req.params;
  const { treeData } = req.body;

  connection.query(
    "UPDATE chapters SET tree_data = ? WHERE id = ?",
    [JSON.stringify(treeData), chapterId],
    (err) => {
      if (err)
        return res.status(500).json({ error: "Failed to update chapter" });
      res.json({ message: "Tree data updated successfully" });
    }
  );
});
// delete
app.delete("/chapters/:chapterId", authenticateToken, (req, res) => {
  const { chapterId } = req.params;

  connection.query("DELETE FROM chapters WHERE id = ?", [chapterId], (err) => {
    if (err) return res.status(500).json({ error: "Failed to delete chapter" });
    res.json({ message: "Chapter deleted successfully" });
  });
});

app.get("/chapters/:chapterId", authenticateToken, (req, res) => {
  const { chapterId } = req.params;

  connection.query(
    "SELECT id, name, tree_data FROM chapters WHERE id = ?",
    [chapterId],
    (err, results) => {
      if (err) {
        console.error("Error fetching chapter details:", err);
        return res
          .status(500)
          .json({ error: "Failed to fetch chapter details." });
      }

      if (results.length === 0) {
        return res.status(404).json({ error: "Chapter not found." });
      }

      const chapter = results[0];

      // Check if `tree_data` is already an object or needs parsing
      let treeData;
      try {
        treeData =
          typeof chapter.tree_data === "string"
            ? JSON.parse(chapter.tree_data) // Parse if it's a string
            : chapter.tree_data; // Directly use if it's already an object
      } catch (error) {
        console.error("Error parsing tree_data:", error);
        return res.status(500).json({ error: "Invalid tree_data format." });
      }

      res.json({
        id: chapter.id,
        name: chapter.name,
        treeData, // Send the parsed/validated tree data to the frontend
      });
    }
  );
});

app.post("/validate-token", (req, res) => {
  const { token } = req.body;

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    res.json({ valid: true });
  } catch (err) {
    res.json({ valid: false });
  }
});

app.post("/evaluate-answer", async (req, res) => {
  const {
    questionsForFile1,
    userAnswerFile1,
    useCase1,
    questionsForFile2,
    userAnswerFile2,
    useCase2,
  } = req.body; // Get the required data from the request body

  try {
    // Build request body based on what's provided
    const requestBody = {};

    // Add file 1 data if provided
    if (questionsForFile1 && userAnswerFile1) {
      requestBody.questionsForFile1 = questionsForFile1;
      requestBody.userAnswerFile1 = userAnswerFile1;
      requestBody.useCase1 = useCase1 || "";
    }

    // Add file 2 data if provided
    if (questionsForFile2 && userAnswerFile2) {
      requestBody.questionsForFile2 = questionsForFile2;
      requestBody.userAnswerFile2 = userAnswerFile2;
      requestBody.useCase2 = useCase2 || "";
    }

    // Check if we have at least one file's data
    if (!Object.keys(requestBody).length) {
      return res.status(422).json({
        error: "Missing data",
        details: "Please provide data for at least one file",
      });
    }

    const response = await axios.post(
      "http://localhost:8002/evaluate-answer",
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error(
      "Error evaluating answer:",
      error.response?.data || error.message
    );
    res.status(error.response?.status || 500).json({
      error: "Error evaluating answer",
      details: error.response?.data || error.message,
    });
  }
});

app.post('/check-cognitive-level', async (req, res) => {
  const { userAnswer, bloomLevel } = req.body;

  try {
    // Check cognitive level for userAnswerFile1
    const response = await axios.post('http://localhost:8003/check-cognitive-level', {
      userAnswer: userAnswer,
      bloomLevel: bloomLevel
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    res.json({ feedback});

  } catch (error) {
    console.error('Error checking level:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: 'Error checking level',
      details: error.response?.data || error.message
    });
  }
});

// Endpoint to save questions and answers
app.post('/save-questions-and-answers', authenticateToken, (req, res) => {
  const { userId } = req.user;
  const { questionsAndAnswers } = req.body;

  if (!questionsAndAnswers || !Array.isArray(questionsAndAnswers) || questionsAndAnswers.length === 0) {
    return res.status(400).json({ error: "Invalid input. Questions and answers are required." });
  }

  const generationId = generateGenerationId(); // Generate a new generation ID
  generationCounter++; // Increment generation counter for the next generation

  const values = questionsAndAnswers.map((qa) => [
    generationId,
    userId,
    qa.questionId,
    qa.caseScenario || null, 
    qa.question, 
    qa.answer,
  ]);

  const query = `
    INSERT INTO questions (generation_id, user_id, question_id, case_scenario, question_text, answer_text)
    VALUES ?;
  `;

  connection.query(query, [values], (err) => {
    if (err) {
      console.error("Error storing questions and answers:", err);
      return res.status(500).json({ error: "Failed to store questions and answers." });
    }
    res.json({ message: "Questions and answers stored successfully.", generationId });
  });
});

app.post('/update-favorite', authenticateToken, (req, res) => {
  const { userId } = req.user;
  const { questionId, favorited } = req.body;

  if (!questionId || typeof favorited !== 'boolean') {
    return res.status(400).json({ error: "Invalid input. Question ID and favorite status are required." });
  }

  const query = `
    UPDATE questions
    SET favourited = ?
    WHERE user_id = ? AND question_id = ?;
  `;

  connection.query(query, [favorited, userId, questionId], (err, result) => {
    if (err) {
      console.error("Error updating favorite status:", err);
      return res.status(500).json({ error: "Failed to update favorite status." });
    }
    res.json({ message: "Favorite status updated successfully.", affectedRows: result.affectedRows });
  });
});

let generationCounter = 1;

function generateGenerationId() {
  return `gid${String(generationCounter).padStart(4, '0')}`;
}

// Initialize counters based on the highest existing IDs in the database
function initializeCounters() {
  connection.query('SELECT MAX(generation_id) AS maxGenerationId FROM questions', (err, results) => {
    if (err) {
      console.error('Error fetching max generation_id:', err);
      return;
    }
    const maxGenerationId = results[0].maxGenerationId;
    if (maxGenerationId) {
      generationCounter = parseInt(maxGenerationId.replace('gid', ''), 10) + 1;
    }
  });
}

// Call initializeCounters when the server starts
//initializeCounters();

app.get('/fetch-questions', authenticateToken, (req, res) => {
  const { userId } = req.user;

  // SQL Query to fetch questions grouped by generation_id and sorted by date
  const query = `
    SELECT 
      generation_id, 
      DATE(created_at) AS date, 
      question_id, 
      case_scenario, 
      question_text, 
      answer_text,
      favourited 
    FROM questions 
    WHERE user_id = ? 
    ORDER BY date DESC, generation_id ASC;
  `;

  connection.query(query, [userId], (err, results) => {
    if (err) {
      console.error("Error fetching questions:", err);
      return res.status(500).json({ error: "Failed to fetch questions." });
    }

    // Group results by date and generation_id
    const groupedQuestions = results.reduce((acc, item) => {
      const { date, generation_id, question_id, case_scenario, question_text, answer_text } = item;

      if (!acc[date]) acc[date] = {}; // Initialise date group
      if (!acc[date][generation_id]) acc[date][generation_id] = []; // Initialise generation_id group

      acc[date][generation_id].push({
        questionId: question_id,
        useCase: case_scenario,
        questionText: question_text,
        answerText: answer_text,
      });

      return acc;
    }, {});

    res.json({ groupedQuestions });
  });
});

app.get('/fetch-favorites', authenticateToken, (req, res) => {
  const { userId } = req.user;

  const query = `
    SELECT question_id, case_scenario, question_text, answer_text
    FROM questions
    WHERE user_id = ? AND favourited = true;
  `;

  connection.query(query, [userId], (err, results) => {
    if (err) {
      console.error("Error fetching favorite questions:", err);
      return res.status(500).json({ error: "Failed to fetch favorite questions." });
    }
    res.json({ favorites: results });
  });
});

// Fetch user data
app.get('/fetch-user', authenticateToken, (req, res) => {
  const { userId } = req.user;

  const query = `
    SELECT 
      username, 
      email, 
      created_at,
      profile_picture AS profilePictureUrl
    FROM users 
    WHERE id = ?;
  `;

  connection.query(query, [userId], (err, results) => {
    if (err) {
      console.error("Error fetching user data:", err);
      return res.status(500).json({ error: "Failed to fetch user data." });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    const userData = results[0];
    console.log('User data:', userData);
    res.json({ userData });
  });
});

app.post('/upload-profile-picture', authenticateToken, upload.single('profilePicture'), (req, res) => {
  const { userId } = req.user;

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  // Create a unique filename
  const filename = Date.now() + '-' + req.file.originalname;
  
  // Define the file path where the image will be saved
  const filePath = path.join(__dirname, 'uploads', filename);
  
  // Write the file buffer to the uploads directory
  fs.writeFile(filePath, req.file.buffer, (err) => {
    if (err) {
      console.error('Error saving file:', err);
      return res.status(500).json({ error: 'Failed to save file.' });
    }

    // Construct the URL to access the file
    const profilePictureUrl = `${req.protocol}://${req.get('host')}/uploads/${filename}`;
    
    // Save the URL to the database or respond to the client
    const query = `
      UPDATE users
      SET profile_picture = ?
      WHERE id = ?;
    `;
    
    connection.query(query, [profilePictureUrl, userId], (err) => {
      if (err) {
        console.error('Error updating profile picture:', err);
        return res.status(500).json({ error: 'Failed to update profile picture.' });
      }

      res.json({ profilePictureUrl });
    });
  });
});

app.post('/update-user-details', authenticateToken, (req, res) => {
  const { userId } = req.user;
  const { username, email } = req.body;

  const query = `
    UPDATE users
    SET username = ?, email = ?
    WHERE id = ?;
  `;

  connection.query(query, [username, email, userId], (err) => {
    if (err) {
      console.error('Error updating user details:', err);
      return res.status(500).json({ error: 'Failed to update user details.' });
    }

    res.json({ message: 'User details updated successfully.' });
  });
});

// Endpoint to change password
app.post('/change-password', authenticateToken, async (req, res) => {
  const { userId } = req.user;
  const { newPassword } = req.body;

  if (!newPassword) {
    return res.status(400).json({ error: 'New password is required.' });
  }

  try {
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    connection.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId], (err) => {
      if (err) {
        console.error('Error updating password:', err);
        return res.status(500).json({ error: 'Failed to update password.' });
      }
      res.json({ message: 'Password updated successfully.' });
    });
  } catch (error) {
    console.error('Error hashing password:', error);
    res.status(500).json({ error: 'Failed to hash password.' });
  }
});

app.post('/update-email', authenticateToken, (req, res) => {
  const { userId } = req.user;
  const { email } = req.body;

  const query = `
    UPDATE users
    SET email = ?
    WHERE id = ?;
  `;

  connection.query(query, [email, userId], (err) => {
    if (err) {
      console.error('Error updating email:', err);
      return res.status(500).json({ error: 'Failed to update email.' });
    }

    res.json({ message: 'Email updated successfully.' });
  });
});

app.listen(3000, () => {
  console.log("Node.js backend running on http://localhost:3000");
});
