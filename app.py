from flask import Flask, request, jsonify
from flask_cors import CORS
import boto3
import os
from werkzeug.utils import secure_filename
from dotenv import load_dotenv

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

        # Upload files to S3
        s3_client.upload_fileobj(thumbnail, S3_BUCKET_NAME, f"{anime_name}/thumbnails/{thumbnail_filename}")
        s3_client.upload_fileobj(video, S3_BUCKET_NAME, f"{anime_name}/videos/{video_filename}")

        if poster:
            s3_client.upload_fileobj(poster, S3_BUCKET_NAME, f"{anime_name}/posters/{poster_filename}")

        return jsonify({'message': 'Files uploaded successfully!'}), 200
    except Exception as e:
        print(e)
        return jsonify({'error': 'Failed to upload files'}), 500


if __name__ == '__main__':
    app.run(debug=True)
