import { Request, Response, NextFunction } from 'express';
import cors from 'cors';

export const errorHandler = (err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
};

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim());

    // allow non-browser tools (curl/postman) with no origin header
    if (!origin) return callback(null, true);

    // For local development, dynamically allow any localhost port
    if (process.env.NODE_ENV !== 'production' && new URL(origin).hostname === 'localhost') {
      return callback(null, true);
    }

    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
});
