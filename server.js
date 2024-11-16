const express = require('express');
const cors = require('cors');
const fileUpload = require('express-fileupload');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const Sequelize = require('sequelize');
const dotenv = require('dotenv');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { createCanvas, loadImage } = require('canvas');

dotenv.config();

const app = express();

app.use(cors({
  origin: '*', // Allow only your frontend domain
  methods: ['GET', 'POST', 'PUT', 'DELETE'], // Allow necessary HTTP methods
  credentials: true, // Include credentials if needed
}));

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

// Create tables if they don't exist
const createTables = async () => {
  const createAnimeEpisodesTableQuery = `
    CREATE TABLE IF NOT EXISTS anime_episodes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      anime_name VARCHAR(255) NOT NULL,
      episode_name VARCHAR(255),
      season_number INT NOT NULL,
      episode_number INT NOT NULL,
      description TEXT,
      thumbnail_url VARCHAR(255) NOT NULL,
      m3u8_url VARCHAR(255),
      complete_status BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  try {
    await sequelize.query(createAnimeEpisodesTableQuery);
    console.log('Checked and ensured the anime_episodes table exists.');
  } catch (error) {
    console.error('Error creating or checking the anime_episodes table:', error);
  }
};

// Call createTables in your server initialization code
(async () => {
  try {
    await sequelize.authenticate();
    console.log('Database connection established.');
    await createTables();
  } catch (error) {
    console.error('Database connection error:', error);
  }
})();

// Upload to S3
const uploadToS3 = async (fileContent, key) => {
  try {
    const uploadParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      Body: fileContent,
    };

    await s3Client.send(new PutObjectCommand(uploadParams));
    console.log(`File uploaded successfully: ${key}`);
  } catch (error) {
    console.error(`Error uploading file: ${error}`);
    throw error;
  }
};

// Process and flatten thumbnail
const processThumbnail = async (inputPath) => {
  try {
    const image = await loadImage(inputPath);
    const canvas = createCanvas(800, (800 / image.width) * image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const buffer = canvas.toBuffer('image/jpeg', { quality: 0.8 });
    return buffer.length > 700 * 1024 ? canvas.toBuffer('image/jpeg', { quality: 0.6 }) : buffer;
  } catch (error) {
    console.error('Error processing thumbnail:', error);
    throw error;
  }
};

// Robust file deletion function
const safeDelete = async (filePath) => {
  try {
    await fs.unlink(filePath);
    console.log(`Successfully deleted: ${filePath}`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`File not found, skipping delete: ${filePath}`);
    } else {
      console.warn(`Warning: Unable to delete file: ${filePath}`, error);
    }
  }
};

// Robust directory deletion function
const safeDeleteDir = async (dirPath) => {
  try {
    const files = await fs.readdir(dirPath);
    for (const file of files) {
      const curPath = path.join(dirPath, file);
      const stats = await fs.lstat(curPath);
      if (stats.isDirectory()) {
        await safeDeleteDir(curPath);
      } else {
        await safeDelete(curPath);
      }
    }
    await fs.rmdir(dirPath);
    console.log(`Successfully deleted directory: ${dirPath}`);
  } catch (error) {
    console.warn(`Warning: Unable to delete directory: ${dirPath}`, error);
  }
};

// Handle video and thumbnail upload
app.post('/upload', async (req, res) => {
  let { animeName, seasonNumber, episodeNumber, episodeName, description } = req.body;
  const thumbnail = req.files?.thumbnail;
  const video = req.files?.video;

  if (!thumbnail || !video) {
    return res.status(400).json({ message: 'Thumbnail and video files are required.' });
  }

  // Trim the inputs to remove leading and trailing spaces
  animeName = animeName.trim();
  episodeName = episodeName.trim();
  seasonNumber = parseInt(seasonNumber.trim(), 10);
  episodeNumber = parseInt(episodeNumber.trim(), 10);
  description = description.trim();

  const uploadsDir = path.join(__dirname, 'uploads');
  const thumbnailDir = path.join(uploadsDir, 'thumbnail');
  const outputDir = path.join(uploadsDir, 'episode', episodeNumber.toString());

  try {
    await createTables();

    const insertEpisodeResult = await sequelize.query(
      'INSERT INTO anime_episodes (anime_name, episode_name, season_number, episode_number, description, complete_status) VALUES (?, ?, ?, ?, ?, ?)',
      {
        replacements: [animeName, episodeName, seasonNumber, episodeNumber, description, false],
        type: Sequelize.QueryTypes.INSERT,
      }
    );

    const episodeId = insertEpisodeResult[0];

    await fs.mkdir(thumbnailDir, { recursive: true });
    const originalThumbnailPath = path.join(thumbnailDir, `original-thumbnail-${Date.now()}.jpg`);
    await thumbnail.mv(originalThumbnailPath);

    const processedThumbnail = await processThumbnail(originalThumbnailPath);

    const thumbnailKey = `${animeName}/thumbnail/thumbnail-${animeName}-${episodeNumber}.jpg`;
    await uploadToS3(processedThumbnail, thumbnailKey);

    const thumbnailUrl = `https://${process.env.CLOUDFRONT_URL}/${thumbnailKey}`;

    await fs.mkdir(outputDir, { recursive: true });
    const tempVideoPath = path.join(outputDir, `temp-${Date.now()}.mp4`);
    await video.mv(tempVideoPath);

    const hlsOutputPath = path.join(outputDir, `${animeName}_${seasonNumber}_${episodeNumber}.m3u8`);

    // Optimized FFmpeg conversion for HLS, with CRF for better file size control
    const ffmpeg = spawn('ffmpeg', [
      '-i', tempVideoPath,
      '-c:v', 'libx264',
      '-preset', 'veryfast', // Faster preset
      '-crf', '23', // Slightly reduced quality
      '-c:a', 'aac',
      '-hls_time', '10', // Duration of each HLS segment
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', `${outputDir}/%03d.ts`,
      '-hls_playlist_type', 'vod',
      '-f', 'hls',
      hlsOutputPath
    ]);

    ffmpeg.stderr.on('data', (data) => {
      console.error(`FFmpeg stderr: ${data}`);
    });

    ffmpeg.on('close', async (code) => {
      if (code !== 0) {
        console.error(`FFmpeg process exited with code ${code}`);
        return res.status(500).json({ message: 'Error processing video.' });
      }

      try {
        const hlsSegments = await fs.readFile(hlsOutputPath, 'utf8');
        const segmentUrls = [];

        const lines = hlsSegments.split('\n');
        for (const line of lines) {
          if (line && line.endsWith('.ts')) {
            const segmentKey = `${animeName}/${seasonNumber}/episode/${episodeNumber}/${line.trim()}`;
            const segmentPath = path.join(outputDir, line.trim());
            await uploadToS3(await fs.readFile(segmentPath), segmentKey);
            segmentUrls.push(`https://${process.env.CLOUDFRONT_URL}/${segmentKey}`);
          }
        }

        const m3u8Key = `${animeName}/${seasonNumber}/episode/${episodeNumber}/${animeName}_${seasonNumber}_${episodeNumber}.m3u8`;
        await uploadToS3(await fs.readFile(hlsOutputPath), m3u8Key);

        const m3u8Url = `https://${process.env.CLOUDFRONT_URL}/${m3u8Key}`;

        // Update the anime_episodes table with the CloudFront-based m3u8 URL
        await sequelize.query(
          'UPDATE anime_episodes SET thumbnail_url = ?, complete_status = ?, m3u8_url = ? WHERE id = ?',
          {
            replacements: [thumbnailUrl, true, m3u8Url, episodeId],
          }
        );

        // Delete temporary files and folders
        await safeDelete(tempVideoPath);
        await safeDelete(originalThumbnailPath);
        await safeDeleteDir(thumbnailDir);
        await safeDeleteDir(outputDir);

        return res.status(200).json({ message: 'Upload and processing complete.', m3u8Url });
      } catch (error) {
        console.error('Error in upload completion:', error);
        return res.status(500).json({ message: 'Error completing upload.' });
      }
    });

  } catch (error) {
    console.error('Error in upload process:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Fetch anime episodes from 'anime_episodes' table
app.get('/anime-episodes', async (req, res) => {
  try {
    const [results] = await sequelize.query('SELECT anime_name, episode_name, season_number, episode_number, thumbnail_url FROM anime_episodes WHERE complete_status = 1');

    if (results.length === 0) {
      return res.status(404).json({ message: 'No anime episodes found' });
    }

    res.json(results);
  } catch (error) {
    console.error('Error fetching anime episodes:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Fetch all episodes for a specific anime by anime name where complete_status = 1
app.get('/fetchAnimeDetails/:animeName', async (req, res) => {
  const { animeName } = req.params;

  try {
    const [results] = await sequelize.query(
      'SELECT * FROM anime_episodes WHERE LOWER(anime_name) = LOWER(?) AND complete_status = 1',
      {
        replacements: [animeName],
      }
    );

    if (results.length === 0) {
      return res.status(404).json({ message: 'No completed episodes found for the specified anime.' });
    }

    res.json(results);
  } catch (error) {
    console.error('Error fetching anime details:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Update episode details
app.put('/update-episode', async (req, res) => {
  const { 
    animeName, 
    episodeName, 
    seasonNumber, 
    episodeNumber, 
    newAnimeName, 
    newEpisodeName, 
    newSeasonNumber, 
    newEpisodeNumber 
  } = req.body;

  // Ensure all required fields are provided
  if (!animeName || !episodeName || !seasonNumber || !episodeNumber || !newAnimeName || !newEpisodeName || !newSeasonNumber || !newEpisodeNumber) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  try {
    // Find the episode in the database based on anime name, season number, and episode number
    const [episode] = await sequelize.query(
      'SELECT * FROM anime_episodes WHERE anime_name = ? AND season_number = ? AND episode_number = ?',
      {
        replacements: [animeName, seasonNumber, episodeNumber],
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    if (!episode) {
      return res.status(404).json({ message: 'Episode not found' });
    }

    // Construct the old and new S3 paths for the updated episode
    const oldThumbnailKey = `${animeName}/thumbnail/thumbnail-${animeName}-${episodeNumber}.jpg`;
    const newThumbnailKey = `${newAnimeName}/thumbnail/thumbnail-${newAnimeName}-${newEpisodeNumber}.jpg`;

    const oldVideoKey = `${animeName}/${seasonNumber}/episode/${episodeNumber}/${animeName}_${seasonNumber}_${episodeNumber}.m3u8`;
    const newVideoKey = `${newAnimeName}/${newSeasonNumber}/episode/${newEpisodeNumber}/${newAnimeName}_${newSeasonNumber}_${newEpisodeNumber}.m3u8`;

    // Update the episode details in the RDS
    await sequelize.query(
      'UPDATE anime_episodes SET anime_name = ?, episode_name = ?, season_number = ?, episode_number = ? WHERE anime_name = ? AND episode_number = ? AND season_number = ?',
      {
        replacements: [newAnimeName, newEpisodeName, newSeasonNumber, newEpisodeNumber, animeName, episodeNumber, seasonNumber],
      }
    );

    // Rename the S3 paths (update the keys for both thumbnail and video files)
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: newThumbnailKey,
      CopySource: `${process.env.S3_BUCKET_NAME}/${oldThumbnailKey}`,
    }));

    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: newVideoKey,
      CopySource: `${process.env.S3_BUCKET_NAME}/${oldVideoKey}`,
    }));

    // After renaming, delete the old files from S3
    await s3Client.send(new DeleteObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: oldThumbnailKey,
    }));

    await s3Client.send(new DeleteObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: oldVideoKey,
    }));

    return res.status(200).json({ message: 'Episode updated successfully' });

  } catch (error) {
    console.error('Error updating episode:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// Delete episode
app.delete('/delete-episode', async (req, res) => {
  const { animeName, seasonNumber, episodeNumber } = req.body;

  if (!animeName || !seasonNumber || !episodeNumber) {
    return res.status(400).json({ message: 'animeName, seasonNumber, and episodeNumber are required' });
  }

  try {
    // Find the episode in the database
    const [episode] = await sequelize.query(
      'SELECT * FROM anime_episodes WHERE anime_name = ? AND season_number = ? AND episode_number = ?',
      {
        replacements: [animeName, seasonNumber, episodeNumber],
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    if (!episode) {
      return res.status(404).json({ message: 'Episode not found' });
    }

    // Log the episode to check if it's the right one
    console.log("Episode to delete:", episode);

    // Delete episode record from the RDS
    await sequelize.query(
      'DELETE FROM anime_episodes WHERE id = ?',
      {
        replacements: [episode.id],
      }
    );

    // Delete corresponding files from S3
    const thumbnailKey = `${animeName}/thumbnail/thumbnail-${animeName}-${episodeNumber}.jpg`;
    const videoKey = `${animeName}/${seasonNumber}/episode/${episodeNumber}/${animeName}_${seasonNumber}_${episodeNumber}.m3u8`;

    // Remove S3 files
    await s3Client.send(new DeleteObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: thumbnailKey,
    }));

    await s3Client.send(new DeleteObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: videoKey,
    }));

    return res.status(200).json({ message: 'Episode deleted successfully' });

  } catch (error) {
    console.error('Error deleting episode:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});