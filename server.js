const express = require('express');
const cors = require('cors');
const fileUpload = require('express-fileupload');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const Sequelize = require('sequelize');
const dotenv = require('dotenv');
const util = require('util');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(fileUpload({ useTempFiles: true, tempFileDir: '/tmp/' }));

// AWS S3 configuration
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// MySQL connection
const sequelize = new Sequelize(process.env.MYSQL_DATABASE_URI);

// Create table for storing episode details
const createTable = async () => {
  const query = `
    CREATE TABLE IF NOT EXISTS anime_episodes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      anime_name VARCHAR(255) NOT NULL,
      episode_name VARCHAR(255),
      season_number INT NOT NULL,
      episode_number INT NOT NULL,
      description TEXT,
      thumbnail_url VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  
  try {
    const [results] = await sequelize.query("SHOW TABLES LIKE 'anime_episodes'");
    if (results.length > 0) {
      console.log('Table "anime_episodes" already exists.');
    } else {
      await sequelize.query(query);
      console.log('Created table "anime_episodes".');
    }
  } catch (error) {
    console.error('Error creating or checking the table:', error);
  }
};

// Upload to S3
const uploadToS3 = async (filePath, key) => {
  try {
    const fileContent = fs.readFileSync(filePath);
    const uploadParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      Body: fileContent,
    };

    await s3Client.send(new PutObjectCommand(uploadParams));
    console.log(`File uploaded successfully: ${key}`);
  } catch (error) {
    console.error(`Error uploading file: ${error}`);
  }
};

// Handle video and thumbnail upload
app.post('/upload', async (req, res) => {
    const {
      animeName,
      seasonNumber,
      episodeNumber,
      episodeName,
      description,
    } = req.body;
  
    const thumbnail = req.files?.thumbnail;
    const video = req.files?.video;
  
    if (!thumbnail || !video) {
      return res.status(400).json({ message: 'Thumbnail and video files are required.' });
    }
  
    try {
      // Handle thumbnail upload (unchanged)
      const thumbnailDir = path.join(__dirname, 'uploads', 'thumbnail');
      if (!fs.existsSync(thumbnailDir)) fs.mkdirSync(thumbnailDir, { recursive: true });
      const thumbnailPath = path.join(thumbnailDir, `thumbnail-${Date.now()}.jpg`);
      await thumbnail.mv(thumbnailPath);
  
      const thumbnailKey = `${animeName}/thumbnail/thumbnail-${animeName}-${episodeNumber}.jpg`;
      await uploadToS3(thumbnailPath, thumbnailKey);
  
      // Save episode details in the database (unchanged)
      await sequelize.query(
        'INSERT INTO anime_episodes (anime_name, episode_name, season_number, episode_number, description, thumbnail_url) VALUES (?, ?, ?, ?, ?, ?)',
        {
          replacements: [
            animeName,
            episodeName,
            seasonNumber,
            episodeNumber,
            description,
            `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${thumbnailKey}`,
          ],
        }
      );
  
      // Process and upload video chunks
      const outputDir = path.join(__dirname, 'uploads', 'episode', episodeNumber);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
  
      // Create a temporary file for the video
      const tempVideoPath = path.join(outputDir, `temp-${Date.now()}.mp4`);
      await video.mv(tempVideoPath);
  
      // Stream video to ffmpeg for chunking
      const ffmpeg = spawn('ffmpeg', [
        '-i', tempVideoPath,
        '-c', 'copy',
        '-map', '0',
        '-f', 'segment',
        '-segment_time', '10',
        `${outputDir}/chunk-${episodeName}-%04d.mp4`
      ]);
  
      ffmpeg.on('close', async (code) => {
        if (code !== 0) {
          console.error(`ffmpeg process exited with code ${code}`);
          return res.status(500).json({ message: 'Error processing video.' });
        }
  
        // Upload video chunks to S3
        const files = await fs.promises.readdir(outputDir);
        for (const file of files) {
          if (file.startsWith('chunk')) {
            const chunkKey = `${animeName}/episode/${episodeNumber}/${file}`;
            await uploadToS3(path.join(outputDir, file), chunkKey);
            await fs.promises.unlink(path.join(outputDir, file)); // Delete local chunk after upload
          }
        }
  
        // Delete the temporary video file
        await fs.promises.unlink(tempVideoPath);
  
        // Send success response
        res.status(200).json({ message: 'Upload successful!' });
      });
  
    } catch (error) {
      console.error('Error in upload handler:', error);
      res.status(500).json({ message: 'Internal server error.' });
    }
  });

// Start server and connect to the database
const startServer = async () => {
  try {
    await sequelize.authenticate();
    console.log('Database connection established.');

    await createTable();
    
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Unable to connect to the database:', error);
  }
};

startServer();