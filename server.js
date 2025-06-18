const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // Use secure cookies in production
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
  }
}));

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

// Determine the callback URL based on environment
const getCallbackURL = () => {
  // For Vercel deployments, use the VERCEL_URL environment variable
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}/auth/google/callback`;
  }
  
  // For production with custom domain
  if (process.env.NODE_ENV === 'production' && process.env.PRODUCTION_URL) {
    return `${process.env.PRODUCTION_URL}/auth/google/callback`;
  }
  
  // For production without custom URL, try to detect from request headers
  if (process.env.NODE_ENV === 'production') {
    // Fallback to a default production URL if available
    return process.env.CALLBACK_URL || "https://auth-token-testing.vercel.app/auth/google/callback";
  }
  
  // Local development
  return process.env.CALLBACK_URL || "http://localhost:3000/auth/google/callback";
};

console.log('Using callback URL:', getCallbackURL());

// Dynamic callback URL function that uses request context
const getDynamicCallbackURL = (req) => {
  if (req && req.headers && req.headers.host) {
    const protocol = req.headers['x-forwarded-proto'] || (req.connection.encrypted ? 'https' : 'http');
    return `${protocol}://${req.headers.host}/auth/google/callback`;
  }
  return getCallbackURL();
};

// Passport Google OAuth Strategy
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: getCallbackURL()
}, async (accessToken, refreshToken, profile, done) => {
  try {
    console.log('=== Google OAuth Callback ===');
    console.log('Profile ID:', profile.id);
    console.log('Profile Name:', profile.displayName);
    console.log('Profile Email:', profile.emails?.[0]?.value);
    console.log('Access Token:', accessToken ? 'Present' : 'Missing');
    console.log('Refresh Token:', refreshToken ? 'Present' : 'Missing');

    // Validate required data
    if (!profile.emails || !profile.emails[0] || !profile.emails[0].value) {
      console.error('No email found in profile');
      return done(new Error('No email found in profile'), null);
    }

    // Store user data and tokens in Supabase
    const userData = {
      google_id: profile.id,
      email: profile.emails[0].value,
      name: profile.displayName || 'Unknown User',
      profile_picture: profile.photos?.[0]?.value || null,
      access_token: accessToken,
      refresh_token: refreshToken || null,
      provider: 'google'
    };

    console.log('Attempting to store user data:', userData);

    // Check if user already exists
    const { data: existingUser, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .eq('google_id', profile.id)
      .maybeSingle();

    console.log('Existing user check result:', { existingUser, fetchError });
    
    if (fetchError) {
      console.error('Error checking existing user:', fetchError);
      return done(fetchError, null);
    }

    let user;
    if (existingUser) {
      console.log('Updating existing user...');
      // Update existing user
      const { data: updatedUser, error: updateError } = await supabase
        .from('users')
        .update({
          name: userData.name,
          email: userData.email,
          profile_picture: userData.profile_picture,
          access_token: accessToken,
          refresh_token: refreshToken || null,
          updated_at: new Date().toISOString()
        })
        .eq('google_id', profile.id)
        .select()
        .single();

      if (updateError) {
        console.error('Error updating user:', updateError);
        return done(updateError, null);
      }
      user = updatedUser;
      console.log('User updated successfully:', user);
    } else {
      console.log('Creating new user...');
      // Create new user
      const { data: newUser, error: insertError } = await supabase
        .from('users')
        .insert([userData])
        .select()
        .single();

      if (insertError) {
        console.error('Error creating user:', insertError);
        console.error('Insert error details:', JSON.stringify(insertError, null, 2));
        return done(insertError, null);
      }
      user = newUser;
      console.log('User created successfully:', user);
    }

    console.log('=== OAuth Success ===');
    return done(null, user);
  } catch (error) {
    console.error('Error in Google OAuth strategy:', error);
    return done(error, null);
  }
}));

// Serialize and deserialize user for session
passport.serializeUser((user, done) => {
  console.log('Serializing user:', user);
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    console.log('Deserializing user with ID:', id);
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      console.error('Error deserializing user:', error);
      return done(error, null);
    }
    console.log('Deserialized user:', user);
    done(null, user);
  } catch (error) {
    console.error('Exception in deserializeUser:', error);
    done(error, null);
  }
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Auth routes
app.get('/auth/google', (req, res, next) => {
  // Log the current request details for debugging
  console.log('=== Auth Request Debug ===');
  console.log('Host:', req.headers.host);
  console.log('Protocol:', req.headers['x-forwarded-proto'] || req.protocol);
  console.log('Original URL:', req.originalUrl);
  console.log('Dynamic Callback URL:', getDynamicCallbackURL(req));
  console.log('Static Callback URL:', getCallbackURL());
  
  passport.authenticate('google', { 
    scope: ['profile', 'email'],
    accessType: 'offline',
    prompt: 'consent'
  })(req, res, next);
});

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => {
    console.log('=== OAuth Callback Success ===');
    console.log('User authenticated:', req.isAuthenticated());
    console.log('User object:', req.user);
    
    if (!req.user) {
      console.error('No user object after authentication');
      return res.redirect('/?error=no_user');
    }
    
    // Successful authentication
    res.redirect('/dashboard');
  }
);

app.get('/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      console.error('Logout error:', err);
    }
    res.redirect('/');
  });
});

// Protected routes
app.get('/dashboard', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// API routes
app.get('/api/user', (req, res) => {
  console.log('=== /api/user called ===');
  console.log('Is authenticated:', req.isAuthenticated());
  console.log('User from session:', req.user);
  
  if (!req.isAuthenticated()) {
    console.log('User not authenticated, returning 401');
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  console.log('Returning user data:', req.user);
  res.json(req.user);
});

// Test Supabase connection
app.get('/api/test-db', async (req, res) => {
  try {
    console.log('Testing Supabase connection...');
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .limit(5);
    
    if (error) {
      console.error('Supabase test error:', error);
      return res.status(500).json({ error: 'Database connection failed', details: error });
    }
    
    console.log('Supabase connection successful, users found:', data?.length || 0);
    res.json({ 
      success: true, 
      message: 'Database connection successful', 
      userCount: data?.length || 0,
      users: data 
    });
  } catch (error) {
    console.error('Supabase test exception:', error);
    res.status(500).json({ error: 'Database connection failed', details: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Environment:', process.env.NODE_ENV || 'development');
  console.log('Callback URL:', getCallbackURL());
  console.log('Supabase URL:', process.env.SUPABASE_URL ? 'Configured' : 'Missing');
  console.log('Google Client ID:', process.env.GOOGLE_CLIENT_ID ? 'Configured' : 'Missing');
  
  if (process.env.NODE_ENV !== 'production') {
    console.log('Local development server running on http://localhost:' + PORT);
    console.log('Make sure to:');
    console.log('1. Set up your Google OAuth credentials');
    console.log('2. Configure your Supabase database');
    console.log('3. Create a .env file with your configuration');
  }
}); 