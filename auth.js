const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');

dotenv.config();

const router = express.Router();

// Middleware to parse cookies
router.use(cookieParser());

// MongoDB User Schema
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  token: { type: String }, // Store JWT token here
  isAdmin: { type: Number, default: 0 }, // isAdmin field is now an integer (0 means user, 1113 or 1134 means admin)
});

const User = mongoose.model('User', userSchema);

// Middleware to authenticate token
const authenticateToken = async (req, res, next) => {
  const token = req.cookies.token;

  if (!token) {
    return res.status(401).json({ message: 'No token, authorization denied.' });
  }

  try {
    // Verify the JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check if token exists in the database
    const user = await User.findById(decoded.userId);
    if (!user || user.token !== token) {
      return res.status(401).json({ message: 'Invalid or expired token.' });
    }

    req.user = user; // Attach user data to request

    // Check if the user is an admin (admin values are 1113 or 1134)
    // Send admin status to the frontend
    if (user.isAdmin === 1113 || user.isAdmin === 1134) {
        return res.status(200).json({ status: 'authenticated', username: req.user.username, email: req.user.email, isAdmin: true });
      }

    next();
  } catch (error) {
    console.error('Token verification failed:', error);
    res.status(401).json({ message: 'Invalid token.' });
  }
};

// Register a new user
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ message: 'Username, email, and password are required.' });
  }

  try {
    // Check if user already exists
    const existingUser = await User.findOne({ $or: [{ username }, { email }] });
    if (existingUser) {
      return res.status(400).json({ message: 'User already exists.' });
    }

    // Hash the password before saving
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create and save the new user (no isAdmin field here, default is 0)
    const user = new User({ username, email, password: hashedPassword });
    await user.save();

    res.status(201).json({ message: 'User registered successfully.' });
  } catch (error) {
    console.error('Error registering user:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// Login a user and return JWT token in cookie
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  try {
    // Check if user exists
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials.' });
    }

    // Check if password matches
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials.' });
    }

    // Generate JWT token
    const token = jwt.sign({ userId: user._id, username: user.username }, process.env.JWT_SECRET, {
      expiresIn: '1h',
    });

    // Store the token in the database
    user.token = token;
    await user.save();

    // Set the token as an HTTP-only cookie
    res.cookie('token', token, {
      secure: true,  // Always secure, requires HTTPS
      httpOnly: true,  // Ensure the cookie is not accessible via JavaScript (security best practice)
      maxAge: 3600000, // 1 hour in milliseconds
    });

    res.status(200).json({ message: 'Login successful.' });
  } catch (error) {
    console.error('Error logging in user:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// Logout (remove token cookie)
router.post('/logout', (req, res) => {
  res.clearCookie('token');  // Clear the token cookie
  res.status(200).json({ message: 'Logged out successfully.' });
});

// Check user authentication status
router.get('/status', authenticateToken, (req, res) => {
  res.status(200).json({ status: 'authenticated', username: req.user.username, email: req.user.email });
});

module.exports = router;