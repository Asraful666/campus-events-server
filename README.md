# CampusEvents — Server

Express and MongoDB backend for CampusEvents, providing authentication integration, role-based authorization, event management, registration, attendance, certificates, and recommendations.

## Project Links

- Server Repository: https://github.com/Asraful666/campus-events-server
- Client Repository: https://github.com/Asraful666/campus-events-client
- Live API: TODO — Add deployed backend URL
- Live Website: TODO — Add deployed frontend URL

## Technology Stack

- Node.js
- Express.js
- JavaScript ES modules
- MongoDB
- MongoDB Node.js driver
- Better Auth
- MongoDB adapter
- JWT plugin
- jose
- cors
- dotenv
- Node.js crypto

## Features

- Email/password authentication through Better Auth
- JWT verification with session validation
- Student, Organizer, and Admin authorization
- Event creation, search, filtering, editing, and cancellation
- Transactional registration with capacity checks
- Duplicate registration prevention
- QR attendance tokens and check-in
- Event ownership checks
- Participant lists and attendance statistics
- Certificate snapshots for eligible attendees
- Favorite events
- Event reviews and ratings
- In-app notifications and reminders
- Personalized event recommendations
- Admin user search and role management

## Local Installation

### 1. Clone the repository

```bash
git clone https://github.com/Asraful666/campus-events-server.git
cd campus-events-server
```

### 2. Install dependencies

```bash
npm install
```

Use Node.js compatible with the installed dependencies and a MongoDB deployment supporting transactions, such as MongoDB Atlas.

### 3. Configure environment variables

Create `.env` in the project root:

```env
PORT=8000
CLIENT_URL=http://localhost:3000

BETTER_AUTH_URL=http://localhost:8000
BETTER_AUTH_SECRET=REPLACE_WITH_A_LONG_RANDOM_SECRET

MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@CLUSTER_HOST/?retryWrites=true&w=majority
MONGODB_DB_NAME=campus_events

# Optional: required only for demo seeding
DEMO_PASSWORD=REPLACE_WITH_A_DEMO_PASSWORD
```

Replace all placeholders with your own values.

Configure Atlas database credentials and network access for the server.

Never commit the actual `.env` file.

### 4. Start the server

```bash
node index.js
```

For automatic restarts during development:

```bash
node --watch index.js
```

### 5. Check server health

- http://localhost:8000/
- http://localhost:8000/api/health

The health endpoint checks the MongoDB connection.

## Authentication and Authorization

Better Auth routes are mounted under `/api/auth/*` before the Express JSON parser.

For protected application routes:

1. The client sends a JWT in the Authorization header.
2. The server verifies the JWT.
3. The server validates the Better Auth session.
4. The token identity must match the session user.
5. The server loads the current role from `user_roles`.
6. Role and ownership checks determine access.

```http
Authorization: Bearer <token>
```

Protected requests also require the valid session cookie.

| Role | Access |
| --- | --- |
| Student | Registration, own tickets and certificates, favorites, and eligible reviews |
| Organizer | Manage owned events, view participants, and record attendance |
| Admin | Manage events and attendance across organizers, and manage user roles |

Users default to the student role when no role record exists.

## Create the Initial Admin

First register the account through the frontend.

Then run:

```bash
node scripts/makeAdmin.js your-email@example.com
```

Use the exact email of the existing account.

Administrators cannot change their own role through the role-management endpoint.

## Main API Endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/` | API status |
| GET | `/api/health` | Database health |
| GET | `/api/me` | Current authenticated user |
| GET | `/api/events` | Public event search, filtering, and pagination |
| GET | `/api/events/:id` | Published event details |
| POST | `/api/events` | Create an event |
| PATCH | `/api/events/:id` | Edit an authorized event |
| DELETE | `/api/events/:id` | Cancel an authorized event |
| GET | `/api/manage/events` | List manageable events |
| GET | `/api/manage/events/:id` | Get an event for editing |
| GET | `/api/manage/events/:id/participants` | View participants |
| POST | `/api/events/:id/register` | Student event registration |
| GET | `/api/events/:id/registration` | Current user's event registration |
| GET | `/api/my-registrations` | Current user's registrations |
| POST | `/api/registrations/:id/ticket` | Generate or retrieve own QR ticket |
| POST | `/api/attendance/check-in` | Record attendance |
| POST | `/api/registrations/:id/certificate` | Generate or retrieve own eligible certificate |
| GET | `/api/favorites` | List own favorites |
| PUT | `/api/favorites/:eventId` | Add a favorite |
| DELETE | `/api/favorites/:eventId` | Remove a favorite |
| GET | `/api/events/:id/reviews` | List event reviews |
| PUT | `/api/events/:id/review` | Create or update own review |
| DELETE | `/api/events/:id/review` | Delete own review |
| GET | `/api/dashboard/summary` | Role-specific statistics |
| GET | `/api/notifications` | Own notifications and unread count |
| PATCH | `/api/notifications/:id/read` | Mark a notification read |
| GET | `/api/recommendations` | Recommended events |
| GET | `/api/admin/users` | Admin user search and pagination |
| PATCH | `/api/admin/users/:id/role` | Update another user's role |
| GET | `/api/organizer/access` | Organizer/admin access check |
| GET | `/api/admin/access` | Admin access check |

## Business Rules

### Events

- Validate title, description, category, venue, capacity, fee, and dates.
- Dates must include an explicit timezone.
- Organizers can manage their own events; admins can manage events across organizers.
- Editable fields include title, description, category, venue, capacity, and fee.
- Schedule editing is not included in the current edit form.
- Capacity cannot be reduced below the registered count.
- Cancellation updates status and preserves registration history.

### Registration

- Registration is available to student accounts.
- The event must be published and have available capacity.
- The registration deadline and event start must be in the future.
- Duplicate registrations are prevented by a unique event/user index.
- Capacity reservation and registration insertion use a transaction.

### Attendance

- QR tickets contain a random attendance token.
- Check-in validates registration, event status, ownership, and timing.
- Check-in is allowed from one hour before event start until event end.
- Duplicate check-in is rejected.

### Certificates and Reviews

- Certificates require an active registration, recorded attendance, and an ended, published event.
- Certificate snapshots are stored in the registration document.
- The frontend prints certificates or saves them as PDF.
- Reviews require attendance at a completed event.
- Each user can maintain one review per event.

Event fees are recorded, but payment processing is not implemented.

## Database Collections

Better Auth manages authentication collections.

Application collections include:

- `user_roles`
- `events`
- `registrations`
- `favorites`
- `reviews`
- `notifications`

Certificate snapshots are embedded in registrations.

Indexes support unique roles, registrations, attendance tokens, favorites, reviews, and notification deduplication.

## Notifications

The notification worker is located at:

```text
jobs/notifications.js
```

It runs immediately and approximately every 60 seconds to create in-app notifications for registrations, cancellations, and upcoming-event reminders.

The backend must remain running. A sleeping or short-lived serverless process cannot provide reliable background reminders. Production use requires a persistent worker or external scheduler.

Email and SMS notifications are not included.

## Event Recommendations

The recommendation service is located at:

```text
services/recommendations.js
```

It uses TF-IDF vectors and cosine similarity to rank upcoming events based on a user's registrations and favorites.

- Excludes already registered and unavailable events.
- Considers up to 200 eligible candidates.
- Returns up to six recommendations.
- Falls back to upcoming events when there is insufficient matching history.
- Does not require an external AI API key.

This is a content-based recommendation baseline, not a generative AI or semantic embedding service.

## Demo Data

Configure `DEMO_PASSWORD` in a development environment, then run:

```bash
node scripts/seedDemo.js
```

| Role | Email |
| --- | --- |
| Admin | admin@campusevents.example |
| Organizer | organizer@campusevents.example |
| Student | student@campusevents.example |
| Student | student2@campusevents.example |

New demo accounts use the configured password. Existing accounts retain their previous passwords.

The script creates demo events and registrations, including completed attendance for certificates and a near-term QR check-in scenario.

Each run creates another event batch. Run it again only when additional demo data is intended.

Do not publish real passwords or production credentials.

## Project Structure

```text
index.js
config/
  db.js
  auth.js
middleware/
  auth.js
jobs/
  notifications.js
services/
  recommendations.js
scripts/
  makeAdmin.js
  seedEvents.js
  seedDemo.js
```

## Manual Testing

1. Verify the health endpoint.
2. Sign in and retrieve the authenticated profile.
3. Confirm students cannot access organizer/admin endpoints.
4. Confirm organizers cannot edit other organizers' events.
5. Test successful, duplicate, full, and closed-event registration.
6. Test attendance within the allowed window.
7. Confirm duplicate attendance is rejected.
8. Verify certificate and review eligibility.
9. Test favorites, role changes, notifications, and recommendations.

## Deployment

- Configure environment variables on the backend host.
- Set `BETTER_AUTH_URL` to the deployed backend origin.
- Set `CLIENT_URL` to the deployed frontend origin.
- Configure MongoDB network access for the hosting environment.
- Verify authentication cookies, trusted origins, and credentialed requests.
- Provide reliable execution for the notification worker.
- Test complete registration and attendance workflows.
- Update the live links in this README.

Commit only placeholder values in `.env.example`; never commit actual secrets.

## Author

**Md Asraful Islam**

GitHub: https://github.com/Asraful666