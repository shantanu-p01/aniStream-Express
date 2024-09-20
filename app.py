from flask import Flask, request, jsonify
from flask_cors import CORS
import boto3
import os
from werkzeug.utils import secure_filename
from dotenv import load_dotenv
import subprocess
import tempfile
import shutil
from flask_sqlalchemy import SQLAlchemy

# Load environment variables
load_dotenv()

app = Flask(__name__)
CORS(app)

# AWS S3 configuration
AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID")
AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY")
AWS_REGION = os.getenv("AWS_REGION")
S3_BUCKET_NAME = os.getenv("S3_BUCKET_NAME")

# PostgreSQL Database configuration
app.config['SQLALCHEMY_DATABASE_URI'] = os.getenv("DATABASE_URL")
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# Initialize the database and S3 client
db = SQLAlchemy(app)

s3_client = boto3.client(
    's3',
    aws_access_key_id=AWS_ACCESS_KEY_ID,
    aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
    region_name=AWS_REGION
)

# Database model
class AnimeUpload(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    anime_name = db.Column(db.String(255), nullable=False)
    season_number = db.Column(db.String(255), nullable=False)
    episode_number = db.Column(db.String(255), nullable=False)
    episode_name = db.Column(db.String(255))
    description = db.Column(db.Text)
    video_links = db.Column(db.Text, nullable=False)
    thumbnail_link = db.Column(db.String(255), nullable=False)
    poster_link = db.Column(db.String(255))

# Create the database tables
with app.app_context():
    db.create_all()

def split_video_into_segments(video_path, segment_duration=10):
    """Splits the video into segments of specified duration using ffmpeg."""
    segments = []
    
    # Create a unique temporary directory to store the video segments
    tempdir = tempfile.mkdtemp()
    
    try:
        segment_pattern = os.path.join(tempdir, 'segment_%03d.mp4')
        
        # Use ffmpeg to split the video into segments
        result = subprocess.run([
            'ffmpeg', '-i', video_path, '-c', 'copy', '-map', '0', '-segment_time', str(segment_duration),
            '-f', 'segment', segment_pattern
        ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        
        # Collect all generated segment files
        for filename in sorted(os.listdir(tempdir)):
            segments.append(os.path.join(tempdir, filename))
    
    except Exception as e:
        print(f"Error during ffmpeg segmentation: {e}")
    
    return segments

@app.route('/upload', methods=['POST'])
def upload_files():
    try:
        if 'thumbnail' not in request.files or 'video' not in request.files:
            return jsonify({'error': 'Thumbnail and video files are required!'}), 400

        anime_name = request.form.get('animeName')
        season_number = request.form.get('seasonNumber')
        episode_number = request.form.get('episodeNumber')
        episode_name = request.form.get('episodeName')
        description = request.form.get('description')

        if not all([anime_name, season_number, episode_number]):
            return jsonify({'error': 'Anime name, season number, and episode number are required!'}), 400

        thumbnail = request.files['thumbnail']
        video = request.files['video']
        poster = request.files.get('poster')

        # Ensure filenames are secure
        thumbnail_filename = secure_filename(thumbnail.filename)
        video_filename = secure_filename(video.filename)
        poster_filename = secure_filename(poster.filename) if poster else None

        # Create initial database entry with textual data
        anime_upload = AnimeUpload(
            anime_name=anime_name,
            season_number=season_number,
            episode_number=episode_number,
            episode_name=episode_name,
            description=description,
            video_links="",
            thumbnail_link="",
            poster_link=""
        )
        db.session.add(anime_upload)
        db.session.commit()

        # Save the uploaded video to a temporary file
        with tempfile.NamedTemporaryFile(delete=False, suffix='.mp4') as temp_video_file:
            video.save(temp_video_file.name)
            temp_video_path = temp_video_file.name

        # Split the video into 10-second segments
        segments = split_video_into_segments(temp_video_path, segment_duration=10)

        video_links = []

        # Upload each video segment to S3 and update the database
        for idx, segment_path in enumerate(segments):
            segment_filename = f"s{season_number}_e{episode_number}_segment_{idx+1:03d}.mp4"
            s3_key = f"{anime_name}/seasons/{season_number}/episodes/{segment_filename}"
            s3_client.upload_file(segment_path, S3_BUCKET_NAME, s3_key)
            segment_link = f"https://{S3_BUCKET_NAME}.s3.{AWS_REGION}.amazonaws.com/{s3_key}"
            video_links.append(segment_link)
            
            # Update database with the new segment link
            anime_upload.video_links = ",".join(video_links)
            db.session.commit()

        # Upload thumbnail to S3 after video segments
        thumbnail_key = f"{anime_name}/{anime_name}_thumbnail.{thumbnail_filename.split('.')[-1]}"
        s3_client.upload_fileobj(thumbnail, S3_BUCKET_NAME, thumbnail_key)
        thumbnail_link = f"https://{S3_BUCKET_NAME}.s3.{AWS_REGION}.amazonaws.com/{thumbnail_key}"
        
        # Update database with thumbnail link
        anime_upload.thumbnail_link = thumbnail_link
        db.session.commit()

        # Upload poster if it exists after the thumbnail
        if poster:
            poster_key = f"{anime_name}/{anime_name}_poster.{poster_filename.split('.')[-1]}"
            s3_client.upload_fileobj(poster, S3_BUCKET_NAME, poster_key)
            poster_link = f"https://{S3_BUCKET_NAME}.s3.{AWS_REGION}.amazonaws.com/{poster_key}"
            
            # Update database with poster link
            anime_upload.poster_link = poster_link
            db.session.commit()

        # Clean up the temporary video file and segment files
        os.remove(temp_video_path)
        shutil.rmtree(os.path.dirname(segments[0]))

        return jsonify({'message': 'Files uploaded and data stored successfully!'}), 200
    except Exception as e:
        print(e)
        return jsonify({'error': 'Failed to upload files'}), 500

if __name__ == '__main__':
    app.run(debug=True)