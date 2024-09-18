from flask import Flask, request, jsonify
from flask_cors import CORS
import boto3
import os
from werkzeug.utils import secure_filename
from dotenv import load_dotenv
import subprocess
import tempfile
import shutil

# Load environment variables
load_dotenv()

app = Flask(__name__)
CORS(app)  # Enable CORS for all routes

# AWS S3 configuration
AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID")
AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY")
AWS_REGION = os.getenv("AWS_REGION")
S3_BUCKET_NAME = os.getenv("S3_BUCKET_NAME")

# Initialize the S3 client
s3_client = boto3.client(
    's3',
    aws_access_key_id=AWS_ACCESS_KEY_ID,
    aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
    region_name=AWS_REGION
)

def split_video_into_segments(video_path, segment_duration=10):
    """Splits the video into segments of specified duration using ffmpeg."""
    segments = []
    
    # Create a unique temporary directory to store the video segments
    tempdir = tempfile.mkdtemp()
    
    try:
        segment_pattern = os.path.join(tempdir, 'segment_%03d.mp4')
        
        # Log the temp directory path to ensure it's created
        print(f"Temp directory for segments: {tempdir}")
        
        # Use ffmpeg to split the video into segments
        result = subprocess.run([
            'ffmpeg', '-i', video_path, '-c', 'copy', '-map', '0', '-segment_time', str(segment_duration),
            '-f', 'segment', segment_pattern
        ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        
        # Log ffmpeg output for debugging
        print(result.stdout.decode())
        print(result.stderr.decode())

        # Collect all generated segment files
        for filename in sorted(os.listdir(tempdir)):
            segments.append(os.path.join(tempdir, filename))
        
        # Log the created segments for debugging
        print(f"Segments created: {segments}")
    
    except Exception as e:
        print(f"Error during ffmpeg segmentation: {e}")
    
    return segments

@app.route('/upload', methods=['POST'])
def upload_files():
    try:
        if 'thumbnail' not in request.files or 'video' not in request.files:
            return jsonify({'error': 'Thumbnail and video files are required!'}), 400

        anime_name = request.form.get('animeName')
        episode_number = request.form.get('episodeNumber')

        thumbnail = request.files['thumbnail']
        video = request.files['video']
        poster = request.files.get('poster')  # Optional poster

        # Ensure filenames are secure
        thumbnail_filename = secure_filename(thumbnail.filename)
        video_filename = secure_filename(video.filename)
        poster_filename = secure_filename(poster.filename) if poster else None

        # Save the uploaded video to a temporary file
        with tempfile.NamedTemporaryFile(delete=False, suffix='.mp4') as temp_video_file:
            video.save(temp_video_file.name)
            temp_video_path = temp_video_file.name

        # Split the video into 10-second segments
        segments = split_video_into_segments(temp_video_path, segment_duration=10)

        # Upload thumbnail to S3
        s3_client.upload_fileobj(thumbnail, S3_BUCKET_NAME, f"{anime_name}/thumbnails/{thumbnail_filename}")

        # Upload each video segment to S3 with the episode number and segment index
        for idx, segment_path in enumerate(segments):
            segment_filename = f"{episode_number}_segment_{idx+1:03d}.mp4"
            s3_client.upload_file(segment_path, S3_BUCKET_NAME, f"{anime_name}/episodes/{segment_filename}")

        # Upload poster if it exists
        if poster:
            s3_client.upload_fileobj(poster, S3_BUCKET_NAME, f"{anime_name}/posters/{poster_filename}")

        # Clean up the temporary video file
        os.remove(temp_video_path)

        return jsonify({'message': 'Files uploaded successfully!'}), 200
    except Exception as e:
        print(e)
        return jsonify({'error': 'Failed to upload files'}), 500


if __name__ == '__main__':
    app.run(debug=True)
