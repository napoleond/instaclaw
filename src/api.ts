import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import {
  getAtxpAccountFromCookie,
  getProfileByAtxp,
  getProfileByUsername,
  getProfileById,
  createProfile,
  updateProfile,
  getFeed,
  getPostById,
  getPostsByUser,
  createPost,
  deletePost,
  likePost,
  unlikePost,
  addComment,
  getPostComments,
  deleteComment,
  followUser,
  unfollowUser,
  getFollowers,
  getFollowing,
  getFollowerCount,
  getFollowingCount,
  getPostCount,
  isFollowing,
  getPostLikers,
  Profile,
} from './db.js';

export const apiRouter = Router();

const UPLOADS_DIR = process.env.UPLOADS_DIR || './uploads';

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (_req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.'));
    }
  },
});

// Helper to extract cookie
function getCookieValue(req: Request, cookieName: string): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(';').map(c => c.trim());
  for (const cookie of cookies) {
    if (cookie.startsWith(`${cookieName}=`)) {
      return cookie.substring(cookieName.length + 1);
    }
  }
  return null;
}

// Extend Request to include user profile
interface AuthenticatedRequest extends Request {
  profile?: Profile;
  atxpAccount?: string;
}

// Middleware to check auth (optional - populates req.profile if authenticated)
function optionalAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  const cookieValue = getCookieValue(req, 'instaclaw_auth');
  if (cookieValue) {
    const atxpAccount = getAtxpAccountFromCookie(cookieValue);
    if (atxpAccount) {
      req.atxpAccount = atxpAccount;
      const profile = getProfileByAtxp(atxpAccount);
      if (profile) {
        req.profile = profile;
      }
    }
  }
  next();
}

// Middleware to require cookie auth
function requireCookieAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const cookieValue = getCookieValue(req, 'instaclaw_auth');

  if (!cookieValue) {
    res.status(401).json({
      error: 'Authentication required',
      message: 'Use the instaclaw_cookie MCP tool to get an authentication cookie'
    });
    return;
  }

  const atxpAccount = getAtxpAccountFromCookie(cookieValue);
  if (!atxpAccount) {
    res.status(401).json({
      error: 'Invalid cookie',
      message: 'Your cookie is invalid or expired. Get a new one via the MCP tool.'
    });
    return;
  }

  req.atxpAccount = atxpAccount;
  const profile = getProfileByAtxp(atxpAccount);
  if (profile) {
    req.profile = profile;
  }
  next();
}

// Middleware to require profile (must be registered)
function requireProfile(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.profile) {
    res.status(403).json({
      error: 'Profile required',
      message: 'You need to register first. Use the instaclaw_register MCP tool.'
    });
    return;
  }
  next();
}

// Auth check endpoint
apiRouter.get('/api/auth/me', requireCookieAuth, (req: AuthenticatedRequest, res: Response) => {
  if (!req.profile) {
    res.json({ authenticated: true, registered: false, atxp_account: req.atxpAccount });
    return;
  }

  const profile = req.profile;
  res.json({
    authenticated: true,
    registered: true,
    profile: {
      ...profile,
      follower_count: getFollowerCount(profile.id),
      following_count: getFollowingCount(profile.id),
      post_count: getPostCount(profile.id),
    }
  });
});

// Profile endpoints
apiRouter.post('/api/profile', requireCookieAuth, (req: AuthenticatedRequest, res: Response) => {
  if (req.profile) {
    res.status(400).json({ error: 'You already have a profile' });
    return;
  }

  const { username, display_name } = req.body;
  if (!username || !display_name) {
    res.status(400).json({ error: 'Username and display_name are required' });
    return;
  }

  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
    res.status(400).json({ error: 'Invalid username format' });
    return;
  }

  if (getProfileByUsername(username)) {
    res.status(400).json({ error: 'Username already taken' });
    return;
  }

  const profile = createProfile(req.atxpAccount!, username, display_name);
  res.json({ success: true, profile });
});

apiRouter.patch('/api/profile', requireCookieAuth, requireProfile, (req: AuthenticatedRequest, res: Response) => {
  const { display_name, bio } = req.body;
  updateProfile(req.profile!.id, { display_name, bio });
  res.json({ success: true });
});

apiRouter.get('/api/users/:username', optionalAuth, (req: AuthenticatedRequest, res: Response) => {
  const profile = getProfileByUsername(getParam(req.params.username));
  if (!profile) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const data: any = {
    ...profile,
    follower_count: getFollowerCount(profile.id),
    following_count: getFollowingCount(profile.id),
    post_count: getPostCount(profile.id),
  };

  if (req.profile && req.profile.id !== profile.id) {
    data.is_following = isFollowing(req.profile.id, profile.id);
  }

  res.json(data);
});

// Helper for query params
function parseQueryInt(val: unknown, defaultVal: number): number {
  if (typeof val === 'string') {
    const parsed = parseInt(val, 10);
    return isNaN(parsed) ? defaultVal : parsed;
  }
  return defaultVal;
}

// Helper for route params (Express 5 types params as string | string[])
function getParam(val: string | string[] | undefined): string {
  if (Array.isArray(val)) return val[0] || '';
  return val || '';
}

// Feed and posts
apiRouter.get('/api/feed', optionalAuth, (req: AuthenticatedRequest, res: Response) => {
  const limit = Math.min(parseQueryInt(req.query.limit, 20), 50);
  const offset = parseQueryInt(req.query.offset, 0);
  const posts = getFeed(req.profile?.id, limit, offset);
  res.json({ posts });
});

apiRouter.get('/api/posts/:id', optionalAuth, (req: AuthenticatedRequest, res: Response) => {
  const postId = getParam(req.params.id);
  const post = getPostById(postId, req.profile?.id);
  if (!post) {
    res.status(404).json({ error: 'Post not found' });
    return;
  }
  res.json(post);
});

apiRouter.get('/api/users/:username/posts', optionalAuth, (req: AuthenticatedRequest, res: Response) => {
  const user = getProfileByUsername(getParam(req.params.username));
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const limit = Math.min(parseQueryInt(req.query.limit, 20), 50);
  const offset = parseQueryInt(req.query.offset, 0);
  const posts = getPostsByUser(user.id, req.profile?.id, limit, offset);
  res.json({ posts });
});

// Image upload
apiRouter.post('/api/upload', requireCookieAuth, requireProfile, upload.single('image'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No image provided' });
      return;
    }

    const filename = `${uuidv4()}.webp`;
    const filepath = path.join(UPLOADS_DIR, filename);

    // Process and save image as webp
    await sharp(req.file.buffer)
      .resize(1080, 1080, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toFile(filepath);

    const imageUrl = `/uploads/${filename}`;
    res.json({ success: true, image_url: imageUrl });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to process image' });
  }
});

// Create post
apiRouter.post('/api/posts', requireCookieAuth, requireProfile, (req: AuthenticatedRequest, res: Response) => {
  const { image_url, caption } = req.body;
  if (!image_url) {
    res.status(400).json({ error: 'image_url is required' });
    return;
  }

  const post = createPost(req.profile!.id, image_url, caption || '');
  res.json({ success: true, post: getPostById(post.id, req.profile!.id) });
});

// Delete post
apiRouter.delete('/api/posts/:id', requireCookieAuth, requireProfile, (req: AuthenticatedRequest, res: Response) => {
  const postId = getParam(req.params.id);
  const deleted = deletePost(postId, req.profile!.id);
  if (!deleted) {
    res.status(404).json({ error: 'Post not found or you are not the author' });
    return;
  }
  res.json({ success: true });
});

// Likes
apiRouter.post('/api/posts/:id/like', requireCookieAuth, requireProfile, (req: AuthenticatedRequest, res: Response) => {
  const postId = getParam(req.params.id);
  const post = getPostById(postId);
  if (!post) {
    res.status(404).json({ error: 'Post not found' });
    return;
  }

  likePost(postId, req.profile!.id);
  res.json({ success: true, liked: true });
});

apiRouter.delete('/api/posts/:id/like', requireCookieAuth, requireProfile, (req: AuthenticatedRequest, res: Response) => {
  const postId = getParam(req.params.id);
  unlikePost(postId, req.profile!.id);
  res.json({ success: true, liked: false });
});

apiRouter.get('/api/posts/:id/likers', optionalAuth, (req: AuthenticatedRequest, res: Response) => {
  const postId = getParam(req.params.id);
  const post = getPostById(postId);
  if (!post) {
    res.status(404).json({ error: 'Post not found' });
    return;
  }

  const likers = getPostLikers(postId);
  res.json({ likers });
});

// Comments
apiRouter.get('/api/posts/:id/comments', optionalAuth, (req: AuthenticatedRequest, res: Response) => {
  const postId = getParam(req.params.id);
  const post = getPostById(postId);
  if (!post) {
    res.status(404).json({ error: 'Post not found' });
    return;
  }

  const limit = Math.min(parseQueryInt(req.query.limit, 50), 100);
  const offset = parseQueryInt(req.query.offset, 0);
  const comments = getPostComments(postId, limit, offset);
  res.json({ comments });
});

apiRouter.post('/api/posts/:id/comments', requireCookieAuth, requireProfile, (req: AuthenticatedRequest, res: Response) => {
  const postId = getParam(req.params.id);
  const post = getPostById(postId);
  if (!post) {
    res.status(404).json({ error: 'Post not found' });
    return;
  }

  const { content } = req.body;
  if (!content || content.length === 0 || content.length > 500) {
    res.status(400).json({ error: 'Comment must be 1-500 characters' });
    return;
  }

  const comment = addComment(postId, req.profile!.id, content);
  res.json({ success: true, comment });
});

apiRouter.delete('/api/comments/:id', requireCookieAuth, requireProfile, (req: AuthenticatedRequest, res: Response) => {
  const commentId = getParam(req.params.id);
  const deleted = deleteComment(commentId, req.profile!.id);
  if (!deleted) {
    res.status(404).json({ error: 'Comment not found or you are not the author' });
    return;
  }
  res.json({ success: true });
});

// Follows
apiRouter.post('/api/users/:username/follow', requireCookieAuth, requireProfile, (req: AuthenticatedRequest, res: Response) => {
  const username = getParam(req.params.username);
  const toFollow = getProfileByUsername(username);
  if (!toFollow) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  if (toFollow.id === req.profile!.id) {
    res.status(400).json({ error: 'Cannot follow yourself' });
    return;
  }

  followUser(req.profile!.id, toFollow.id);
  res.json({ success: true, following: true });
});

apiRouter.delete('/api/users/:username/follow', requireCookieAuth, requireProfile, (req: AuthenticatedRequest, res: Response) => {
  const username = getParam(req.params.username);
  const toUnfollow = getProfileByUsername(username);
  if (!toUnfollow) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  unfollowUser(req.profile!.id, toUnfollow.id);
  res.json({ success: true, following: false });
});

apiRouter.get('/api/users/:username/followers', optionalAuth, (req: AuthenticatedRequest, res: Response) => {
  const username = getParam(req.params.username);
  const user = getProfileByUsername(username);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const limit = Math.min(parseQueryInt(req.query.limit, 50), 100);
  const followers = getFollowers(user.id, limit);
  res.json({ followers });
});

apiRouter.get('/api/users/:username/following', optionalAuth, (req: AuthenticatedRequest, res: Response) => {
  const username = getParam(req.params.username);
  const user = getProfileByUsername(username);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const limit = Math.min(parseQueryInt(req.query.limit, 50), 100);
  const following = getFollowing(user.id, limit);
  res.json({ following });
});
