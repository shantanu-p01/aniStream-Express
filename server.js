const express = require('express');
const cors = require('cors');
const fileUpload = require('express-fileupload');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const Sequelize = require('sequelize');
const dotenv = require('dotenv');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { createCanvas, loadImage } = require('canvas');

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
      chunk_urls JSON,
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
  const { animeName, seasonNumber, episodeNumber, episodeName, description } = req.body;
  const thumbnail = req.files?.thumbnail;
  const video = req.files?.video;

  if (!thumbnail || !video) {
    return res.status(400).json({ message: 'Thumbnail and video files are required.' });
  }

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

    const thumbnailUrl = `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${thumbnailKey}`;

    await fs.mkdir(outputDir, { recursive: true });
    const tempVideoPath = path.join(outputDir, `temp-${Date.now()}.mp4`);
    await video.mv(tempVideoPath);

    const hlsOutputPath = path.join(outputDir, `${animeName}_${seasonNumber}_${episodeNumber}.m3u8`);

    // Optimized FFmpeg conversion for HLS, chunk duration 10s, max chunk size 10MB
    const ffmpeg = spawn('ffmpeg', [
      '-i', tempVideoPath,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'fastdecode,zerolatency',
      '-b:v', '8M', // Limit bitrate to ensure chunk size stays under 10MB
      '-threads', '4',
      '-c:a', 'aac',
      '-hls_time', '10',
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
            segmentUrls.push(`https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${segmentKey}`);
          }
        }

        const m3u8Key = `${animeName}/${seasonNumber}/episode/${episodeNumber}/${animeName}_${seasonNumber}_${episodeNumber}.m3u8`;
        await uploadToS3(await fs.readFile(hlsOutputPath), m3u8Key);

        const m3u8Url = `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${m3u8Key}`;

        // Update the anime_episodes table with the m3u8 URL and chunk URLs
        await sequelize.query(
          'UPDATE anime_episodes SET thumbnail_url = ?, chunk_urls = ?, complete_status = ?, m3u8_url = ? WHERE id = ?',
          {
            replacements: [thumbnailUrl, JSON.stringify(segmentUrls), true, m3u8Url, episodeId],
          }
        );

        // Delete temporary files and folders
        await safeDelete(tempVideoPath);
        await safeDelete(originalThumbnailPath);
        await safeDeleteDir(thumbnailDir);
        await safeDeleteDir(outputDir);
        await safeDeleteDir(uploadsDir); // Delete the 'uploads' folder itself after processing

        return res.status(200).json({
          message: 'Video and thumbnail uploaded successfully.',
          m3u8_url: m3u8Url,
          thumbnail_url: thumbnailUrl,
          chunk_urls: segmentUrls
        });
      } catch (error) {
        console.error('Error during video upload process:', error);
        return res.status(500).json({ message: 'Error during video upload process.' });
      }
    });
  } catch (error) {
    console.error('Error handling video and thumbnail upload:', error);
    return res.status(500).json({ message: 'Internal server error.' });
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

// Fetch all episodes for a specific anime by anime name
app.get('/fetchAnimeDetails/:animeName', async (req, res) => {
  const { animeName } = req.params;

  try {
    const [results] = await sequelize.query(
      'SELECT * FROM anime_episodes WHERE LOWER(anime_name) = LOWER(?)',
      {
        replacements: [animeName],
      }
    );

    if (results.length === 0) {
      return res.status(404).json({ message: 'Anime not found' });
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