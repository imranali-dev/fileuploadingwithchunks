# 🧑‍💻 Copilot Instructions for Large File Upload System

## Project Overview
- Node.js/Express backend for large file uploads (up to 5GB) using MongoDB GridFS.
- Chunked/resumable uploads (50MB chunks), robust error handling, security, and monitoring.
- Modular architecture: controllers, middleware, models, services, routes, utils.

## Key Architectural Patterns
- **Chunked Upload Flow**: `/api/upload/init` → `/api/upload/chunk` (multiple) → `/api/upload/complete`.
- **GridFS Storage**: Files are stored in MongoDB via GridFS, managed in `models/FileUpload.js` and `services/fileUpload.js`.
- **Error Handling**: All errors use custom classes in `utils/errors.js` and are returned in a standard JSON format.
- **Logging**: Winston-based logging (`services/logger.js`), with daily rotation and structured metadata.
- **Security**: Rate limiting, CORS, helmet, and Joi validation in `middleware/security.js` and `middleware/validation.js`.
- **Cleanup**: Automated and manual cleanup of expired, stale, and orphaned files via `scripts/cleanup.js`.

## Developer Workflows
- **Start (dev)**: `npm run dev` (nodemon)
- **Start (prod)**: `npm run prod` or `./deploy.sh`
- **Test**: `npm test`, `npm run test:watch`, coverage via `npm test -- --coverage`
- **Lint/Format**: `npm run lint`, `npm run lint:fix`, `npm run format`
- **Cleanup**: `npm run cleanup` or `node scripts/cleanup.js`
- **Logs**: Check `logs/` directory; clear with `npm run logs:clear`

## Conventions & Patterns
- **Controllers**: All request handling in `controllers/index.js`.
- **Services**: Business logic in `services/` (e.g., file upload, database, logger).
- **Middleware**: Validation and security in `middleware/`.
- **Models**: MongoDB schemas in `models/`.
- **Routes**: API endpoints in `routes/api.js`.
- **Error Format**: Always return errors as `{ success: false, error, type, timestamp, path, method }`.
- **Environment**: Use `.env` (see `env.example` for required vars).

## Integration Points
- **MongoDB**: Connection managed in `services/database.js`.
- **Frontend**: Basic UI in `index.html` (for manual testing).
- **Deployment**: Use `deploy.sh` for automated setup and health monitoring.

## Examples
- To add a new API route, update `routes/api.js` and implement logic in `controllers/index.js`.
- To add a new error type, extend `utils/errors.js` and use in controllers/services.
- For new cleanup logic, update `scripts/cleanup.js` and ensure it's reflected in `npm run cleanup`.

## References
- See `README.md` for full architecture, scripts, and troubleshooting.
- Key files: `app.js`, `controllers/index.js`, `services/fileUpload.js`, `utils/errors.js`, `middleware/validation.js`, `routes/api.js`.

---
**For unclear or missing conventions, ask the user for clarification or examples.**
