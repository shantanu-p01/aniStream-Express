const express = require('express');
const cors = require('cors');
const fileUpload = require('express-fileupload');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const Sequelize = require('sequelize');
const dotenv = require('dotenv');
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

// Create table for storing episode details, including chunk_urls
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
      chunk_urls JSON,  -- Add this column to store chunk URLs as a JSON array
      complete_status BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  try {
    await sequelize.query(query);
    console.log('Checked and ensured the table "anime_episodes" exists.');
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
    // Step 1: Check and create the table if it doesn't exist
    await createTable();

    // Step 2: Save episode details in the database with complete_status set to false
    const insertResult = await sequelize.query(
      'INSERT INTO anime_episodes (anime_name, episode_name, season_number, episode_number, description, complete_status) VALUES (?, ?, ?, ?, ?, ?)',
      {
        replacements: [
          animeName,
          episodeName,
          seasonNumber,
          episodeNumber,
          description,
          false, // complete_status set to false initially
        ],
        type: Sequelize.QueryTypes.INSERT,
      }
    );

    // Use the last inserted ID
    const episodeId = insertResult[0];

    // Step 3: Handle thumbnail upload
    const thumbnailDir = path.join(__dirname, 'uploads', 'thumbnail');
    if (!fs.existsSync(thumbnailDir)) fs.mkdirSync(thumbnailDir, { recursive: true });
    const thumbnailPath = path.join(thumbnailDir, `thumbnail-${Date.now()}.jpg`);
    await thumbnail.mv(thumbnailPath);

    const thumbnailKey = `${animeName}/thumbnail/thumbnail-${animeName}-${episodeNumber}.jpg`;
    await uploadToS3(thumbnailPath, thumbnailKey);

    // Step 4: Process and upload video chunks
    const outputDir = path.join(__dirname, 'uploads', 'episode', episodeNumber);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const tempVideoPath = path.join(outputDir, `temp-${Date.now()}.mp4`);
    await video.mv(tempVideoPath);

    const ffmpeg = spawn('ffmpeg', [
      '-i', tempVideoPath,
      '-c', 'copy',
      '-map', '0',
      '-f', 'segment',
      '-segment_time', '10',
      `${outputDir}/chunk-${episodeName}-%04d.mp4`
    ]);

    const chunkUrls = [];

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
          chunkUrls.push(`https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${chunkKey}`);
          await fs.promises.unlink(path.join(outputDir, file)); // Delete local chunk after upload
        }
      }

      // Delete the temporary video file and thumbnail after upload
      await fs.promises.unlink(tempVideoPath);
      await fs.promises.unlink(thumbnailPath);

      // Step 5: Update complete_status and chunk_urls to true in the database
      await sequelize.query(
        'UPDATE anime_episodes SET thumbnail_url = ?, chunk_urls = ?, complete_status = ? WHERE id = ?',
        {
          replacements: [
            `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${thumbnailKey}`,
            JSON.stringify(chunkUrls),
            true, // complete_status to true
            episodeId,
          ],
        }
      );

      // Delete the entire 'uploads' folder after everything is uploaded
      const uploadsDir = path.join(__dirname, 'uploads');
      await fs.promises.rm(uploadsDir, { recursive: true, force: true });

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

    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Unable to connect to the database:', error);
  }
};

startServer();
