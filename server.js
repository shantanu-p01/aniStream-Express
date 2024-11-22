const express = require('express');
const cors = require('cors');
const fileUpload = require('express-fileupload');
const { S3Client, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const Sequelize = require('sequelize');
const dotenv = require('dotenv');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { createCanvas, loadImage } = require('canvas');
const mongoose = require('mongoose');
const authRoutes = require('./auth'); // Import authentication routes
const cron = require('node-cron');

dotenv.config();

const app = express();

const corsOptions = {
  origin: 'http://192.168.101.70:5173', // your frontend URL
  methods: ['GET', 'POST', 'PUT', 'DELETE'], // allow required methods
  allowedHeaders: ['Content-Type', 'Authorization'], // allow headers
  credentials: true, // allow credentials (cookies, authorization headers)
};

app.use(cors(corsOptions));  // Use CORS with the specified options

app.use(express.json());
app.use(fileUpload({ useTempFiles: true, tempFileDir: '/tmp/' }));

// MongoDB connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('Error connecting to MongoDB:', err));

// Import AWS S3 configuration and Sequelize (MySQL) as before
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

app.use('/auth', authRoutes);

// MySQL connection
const sequelize = new Sequelize(process.env.MYSQL_DATABASE_URI);

let connectionEstablished = false;

// Cron job to retry RDS database connection
const retryCronJob = cron.schedule('* * * * *', async () => {
  console.log('Checking RDS database connection...');

  try {
    await sequelize.authenticate();
    console.log('Database connected successfully.');

    // Stop the retry cron job once the connection is established
    connectionEstablished = true;
    retryCronJob.stop();
    console.log('Retry Cron job stopped as the RDS database connection is established.');

    // Start the monitor cron job
    monitorCronJob.start();
    console.log('Monitor Cron job started to keep an eye on the connection.');
  } catch (error) {
    console.error('RDS Database connection failed. Retrying in 1 minute...');
  }
}, {
  scheduled: false, // Start explicitly only when required
});

// Cron job to monitor the RDS database connection
const monitorCronJob = cron.schedule('* * * * *', async () => {
  console.log('Monitoring RDS database connection...');

  try {
    await sequelize.authenticate();
    console.log('Database connection is still active.');
  } catch (error) {
    console.error('Database connection lost. Re-activating Retry Cron job...');
    
    // Stop the monitor cron job and start retrying
    monitorCronJob.stop();
    connectionEstablished = false;
    retryCronJob.start();
    console.log('Retry Cron job reactivated to reconnect the database.');
  }
}, {
  scheduled: false, // Start explicitly after successful connection
});

// Start the retry cron job on application start
console.log('Initializing database connection...');
retryCronJob.start();

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
      categories TEXT,
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
    console.log('RDS Database connection established.');
    await createTables();
  } catch (error) {
    console.error('RDS Database connection error');
    // console.error('RDS Database connection error', error);
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
  let { animeName, seasonNumber, episodeNumber, episodeName, description, categories } = req.body;
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
  categories = categories || [];

  const uploadsDir = path.join(__dirname, 'uploads');
  const thumbnailDir = path.join(uploadsDir, 'thumbnail');
  const outputDir = path.join(uploadsDir, 'episode', episodeNumber.toString());

  try {
    await createTables();

    const insertEpisodeResult = await sequelize.query(
      'INSERT INTO anime_episodes (anime_name, episode_name, season_number, episode_number, description, categories, complete_status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      {
        replacements: [animeName, episodeName, seasonNumber, episodeNumber, description, JSON.stringify(categories), false],
        type: Sequelize.QueryTypes.INSERT,
      }
    );

    const episodeId = insertEpisodeResult[0];

    await fs.mkdir(thumbnailDir, { recursive: true });
    const originalThumbnailPath = path.join(thumbnailDir, `original-thumbnail-${Date.now()}.jpg`);
    await thumbnail.mv(originalThumbnailPath);

    const processedThumbnail = await processThumbnail(originalThumbnailPath);

    const thumbnailKey = `${animeName}/thumbnail-s${seasonNumber}-ep${episodeNumber}.jpg`; // Changed to .jpg for simplicity
    await uploadToS3(processedThumbnail, thumbnailKey);

    const thumbnailUrl = `https://${process.env.CLOUDFRONT_URL}/${thumbnailKey}`;

    await fs.mkdir(outputDir, { recursive: true });
    const tempVideoPath = path.join(outputDir, `temp-${Date.now()}.mp4`);
    await video.mv(tempVideoPath);

    const hlsOutputPath = path.join(outputDir, `${animeName}_s${seasonNumber}_ep${episodeNumber}.m3u8`);

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
        const segmentUrls = [];
        const hlsSegments = await fs.readFile(hlsOutputPath, 'utf8');
        const lines = hlsSegments.split('\n');
        let segmentIndex = 0;
        const updatedM3U8Lines = [];
    
        for (const line of lines) {
          if (line.trim().endsWith('.ts')) {
            // Zero-pad the segment index
            const paddedIndex = segmentIndex.toString().padStart(6, '0'); // e.g., "000000"
            const renamedSegment = `${paddedIndex}.ts`;
    
            // Update the m3u8 reference
            updatedM3U8Lines.push(renamedSegment);
    
            // Read the original segment and rename locally
            const originalSegmentPath = path.join(outputDir, line.trim());
            const renamedSegmentPath = path.join(outputDir, renamedSegment);
            await fs.rename(originalSegmentPath, renamedSegmentPath);
    
            // Upload the renamed segment to S3
            const segmentKey = `${animeName}/season-${seasonNumber}/episode-${episodeNumber}/${renamedSegment}`;
            const segmentData = await fs.readFile(renamedSegmentPath);
            await uploadToS3(segmentData, segmentKey);
    
            // Generate CloudFront URL for the segment
            segmentUrls.push(`https://${process.env.CLOUDFRONT_URL}/${segmentKey}`);
    
            segmentIndex++;
          } else {
            // Retain non-TS lines (e.g., EXTINF and headers) in the updated M3U8
            updatedM3U8Lines.push(line);
          }
        }
    
        // Save the updated .m3u8 file locally
        const updatedM3U8Content = updatedM3U8Lines.join('\n');
        await fs.writeFile(hlsOutputPath, updatedM3U8Content);
    
        // Upload the updated .m3u8 file to S3
        const m3u8Key = `${animeName}/season-${seasonNumber}/episode-${episodeNumber}/${animeName}-s${seasonNumber}-ep${episodeNumber}.m3u8`;
        await uploadToS3(updatedM3U8Content, m3u8Key);
    
        const m3u8Url = `https://${process.env.CLOUDFRONT_URL}/${m3u8Key}`;
    
        // Update the database with the CloudFront-based m3u8 URL
        await sequelize.query(
          'UPDATE anime_episodes SET thumbnail_url = ?, complete_status = ?, m3u8_url = ?, categories = ? WHERE id = ?',
          {
            replacements: [thumbnailUrl, true, m3u8Url, JSON.stringify(categories), episodeId],
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

// Delete episode
app.delete('/delete-episode', async (req, res) => {
  const { animeName, seasonNumber, episodeNumber } = req.body;

  if (!animeName || !seasonNumber || !episodeNumber) {
    return res.status(400).json({ message: 'animeName, seasonNumber, and episodeNumber are required.' });
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
      return res.status(404).json({ message: 'Episode not found.' });
    }

    // Log the episode details
    console.log('Episode to delete:', episode);

    // Prepare S3 keys for the episode
    const thumbnailKey = episode.thumbnail_url.split(`https://${process.env.CLOUDFRONT_URL}/`)[1]; // Extract the S3 key
    const episodePrefix = `${animeName}/season-${seasonNumber}/episode-${episodeNumber}/`;

    // Remove the thumbnail file from S3
    if (thumbnailKey) {
      try {
        await s3Client.send(new DeleteObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME,
          Key: thumbnailKey,
        }));
        console.log(`Deleted thumbnail: ${thumbnailKey}`);
      } catch (error) {
        console.warn(`Failed to delete thumbnail: ${thumbnailKey}`, error);
      }
    }

    // List and delete all files in the episode folder from S3
    const listObjectsCommand = {
      Bucket: process.env.S3_BUCKET_NAME,
      Prefix: episodePrefix,
    };

    const { Contents: objects } = await s3Client.send(new ListObjectsV2Command(listObjectsCommand));

    if (objects && objects.length > 0) {
      const deleteObjectsCommand = {
        Bucket: process.env.S3_BUCKET_NAME,
        Delete: {
          Objects: objects.map((obj) => ({ Key: obj.Key })),
        },
      };

      await s3Client.send(new DeleteObjectsCommand(deleteObjectsCommand));
      console.log(`Deleted all files under prefix: ${episodePrefix}`);
    }

    // Delete episode record from the database
    await sequelize.query(
      'DELETE FROM anime_episodes WHERE id = ?',
      {
        replacements: [episode.id],
      }
    );

    return res.status(200).json({ message: 'Episode and associated files deleted successfully.' });

  } catch (error) {
    console.error('Error deleting episode:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
});

// Fetch anime episodes from 'anime_episodes' table
app.get('/anime-episodes', async (req, res) => {
  try {
    const [results] = await sequelize.query('SELECT anime_name, episode_name, season_number, episode_number, thumbnail_url, categories FROM anime_episodes WHERE complete_status = 1');

    if (results.length === 0) {
      return res.status(404).json({ message: 'No anime episodes found' });
    }

    // Parse categories from JSON string and include it in the response
    const episodes = results.map((episode) => ({
      ...episode,
      categories: JSON.parse(episode.categories),  // Convert categories from JSON string to array
    }));

    res.json(episodes);
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

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});