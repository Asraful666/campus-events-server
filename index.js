import express from "express";
import cors from "cors";
import { ObjectId } from "mongodb";
import "dotenv/config";
import { randomBytes } from "node:crypto";

import {
  connectDB,
  closeDB,
  getMongoClient,
} from "./config/db.js";
import { toNodeHandler } from "better-auth/node";
import { createAuth } from "./config/auth.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { startNotificationWorker } from "./jobs/notifications.js";
import { rankEvents } from "./services/recommendations.js";

const app = express();
const port = Number(process.env.PORT) || 8000;

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  })
);

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Campus Events API is running",
  });
});

async function startServer() {
  const db = await connectDB();
  const auth = createAuth(db);

  // Better Auth handler must come before express.json().
  app.all(/^\/api\/auth(?:\/.*)?$/, toNodeHandler(auth));

  app.use(express.json());

  // Initialize collections and middleware before using them.
  const rolesCollection = db.collection("user_roles");
  const eventsCollection = db.collection("events");

  const { requireAuth, requireRole } =
    createAuthMiddleware(auth, db);

  await rolesCollection.createIndex(
    { userId: 1 },
    { unique: true }
  );

  await eventsCollection.createIndex({
    status: 1,
    startDate: 1,
  });


  const registrationsCollection = db.collection("registrations");

await registrationsCollection.createIndex(
  { eventId: 1, userId: 1 },
  { unique: true }
);

//favorite collection
const favoritesCollection = db.collection("favorites");

await favoritesCollection.createIndex(
  { userId: 1, eventId: 1 },
  { unique: true }
);
//rating collection
const reviewsCollection = db.collection("reviews");

await reviewsCollection.createIndex(
  { eventId: 1, userId: 1 },
  { unique: true }
);
//notification collection
const notificationsCollection = db.collection("notifications");

await notificationsCollection.createIndex(
  { key: 1 },
  { unique: true }
);

await notificationsCollection.createIndex({
  userId: 1,
  createdAt: -1,
});

await notificationsCollection.createIndex({
  userId: 1,
  read: 1,
});


  // Database health check.
  app.get("/api/health", async (req, res, next) => {
    try {
      await db.command({ ping: 1 });

      res.json({
        success: true,
        status: "ok",
        database: "connected",
      });
    } catch (error) {
      next(error);
    }
  });

  await registrationsCollection.createIndex(
  { attendanceToken: 1 },
  { unique: true, sparse: true }
);

  // Current authenticated user.
  app.get("/api/me", requireAuth, (req, res) => {
    res.json({
      success: true,
      data: req.user,
    });
  });

  // Organizer and Admin access check.
  app.get(
    "/api/organizer/access",
    requireAuth,
    requireRole("organizer", "admin"),
    (req, res) => {
      res.json({
        success: true,
        message: "Organizer access granted",
      });
    }
  );

  // Admin access check.
  app.get(
    "/api/admin/access",
    requireAuth,
    requireRole("admin"),
    (req, res) => {
      res.json({
        success: true,
        message: "Admin access granted",
      });
    }
  );

  // Admin can update another user's role.
  app.patch(
    "/api/admin/users/:id/role",
    requireAuth,
    requireRole("admin"),
    async (req, res, next) => {
      try {
        const { id } = req.params;
        const { role } = req.body || {};

        if (!["student", "organizer", "admin"].includes(role)) {
          return res.status(400).json({
            success: false,
            message: "Invalid role",
          });
        }

        if (id === req.user.id) {
          return res.status(400).json({
            success: false,
            message: "You cannot change your own role here",
          });
        }

        if (!/^[a-fA-F0-9]{24}$/.test(id)) {
          return res.status(400).json({
            success: false,
            message: "Invalid user ID",
          });
        }

        const user = await db.collection("user").findOne({
          _id: new ObjectId(id),
        });

        if (!user) {
          return res.status(404).json({
            success: false,
            message: "User not found",
          });
        }

        await rolesCollection.updateOne(
          { userId: id },
          {
            $set: {
              role,
              updatedAt: new Date(),
            },
            $setOnInsert: {
              createdAt: new Date(),
            },
          },
          { upsert: true }
        );

        res.json({
          success: true,
          message: "User role updated",
          data: {
            userId: id,
            role,
          },
        });
      } catch (error) {
        next(error);
      }
    }
  );

  // Create event: Organizer or Admin only.
  app.post(
    "/api/events",
    requireAuth,
    requireRole("organizer", "admin"),
    async (req, res, next) => {
      try {
        const {
          title,
          description,
          category,
          venue,
          startDate,
          endDate,
          registrationDeadline,
          capacity,
          fee,
        } = req.body || {};

        const allowedCategories = [
          "Workshop",
          "Seminar",
          "Competition",
          "Cultural",
          "Sports",
          "Other",
        ];

        function validText(value, min, max) {
          return (
            typeof value === "string" &&
            value.trim().length >= min &&
            value.trim().length <= max
          );
        }

        if (
          !validText(title, 5, 150) ||
          !validText(description, 20, 5000) ||
          !validText(venue, 3, 200)
        ) {
          return res.status(400).json({
            success: false,
            message:
              "Check title (5–150), description (20–5000) and venue (3–200 characters).",
          });
        }

        if (!allowedCategories.includes(category)) {
          return res.status(400).json({
            success: false,
            message: "Select a valid category",
          });
        }

        if (
          !Number.isInteger(capacity) ||
          capacity < 1 ||
          capacity > 100000
        ) {
          return res.status(400).json({
            success: false,
            message:
              "Capacity must be a whole number from 1 to 100000",
          });
        }

        if (
          typeof fee !== "number" ||
          !Number.isFinite(fee) ||
          fee < 0 ||
          fee > 1000000
        ) {
          return res.status(400).json({
            success: false,
            message: "Enter a valid fee from 0 to 1000000",
          });
        }

        function parseDate(value) {
          if (
            typeof value !== "string" ||
            !/(Z|[+-]\d{2}:\d{2})$/.test(value)
          ) {
            return null;
          }

          const date = new Date(value);

          return Number.isNaN(date.getTime()) ? null : date;
        }

        const start = parseDate(startDate);
        const end = parseDate(endDate);
        const deadline = parseDate(registrationDeadline);
        const now = new Date();

        if (!start || !end || !deadline) {
          return res.status(400).json({
            success: false,
            message: "Enter valid dates with a timezone",
          });
        }

        if (start <= now || end <= start) {
          return res.status(400).json({
            success: false,
            message:
              "Event must start in the future and end after its start",
          });
        }

        if (deadline <= now || deadline > start) {
          return res.status(400).json({
            success: false,
            message:
              "Registration deadline must be in the future and no later than the event start",
          });
        }

        const event = {
          title: title.trim(),
          description: description.trim(),
          category,
          venue: venue.trim(),
          startDate: start,
          endDate: end,
          registrationDeadline: deadline,
          capacity,
          fee,
          organizerId: req.user.id,
          status: "published",
          createdAt: now,
          updatedAt: now,
        };

        const result = await eventsCollection.insertOne(event);

        res.status(201).json({
          success: true,
          message: "Event created successfully",
          data: {
            ...event,
            _id: result.insertedId,
          },
        });
      } catch (error) {
        next(error);
      }
    }
  );

  // Public: list published events.
  // Public: search, filter and paginate published events.
app.get("/api/events", async (req, res, next) => {
  try {
    const search =
      typeof req.query.search === "string"
        ? req.query.search.trim()
        : "";

    const category =
      typeof req.query.category === "string"
        ? req.query.category
        : "";

    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 6);

    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > 100000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 30
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid page or limit",
      });
    }

    if (search.length > 100) {
      return res.status(400).json({
        success: false,
        message: "Search must not exceed 100 characters",
      });
    }

    const categories = [
      "Workshop",
      "Seminar",
      "Competition",
      "Cultural",
      "Sports",
      "Other",
    ];

    if (category && !categories.includes(category)) {
      return res.status(400).json({
        success: false,
        message: "Invalid category",
      });
    }

    const filter = { status: "published" };

    if (category) {
      filter.category = category;
    }

    if (search) {
      // Treat user input as literal text, not a regex pattern.
      const escaped = search.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

      filter.$or = [
        { title: { $regex: escaped, $options: "i" } },
        { venue: { $regex: escaped, $options: "i" } },
      ];
    }

    const [events, total] = await Promise.all([
      eventsCollection
        .find(filter)
        .sort({ startDate: 1, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),

      eventsCollection.countDocuments(filter),
    ]);

    res.json({
      success: true,
      count: events.length,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      data: events,
    });
  } catch (error) {
    next(error);
  }
});

  // Public: published event details.
  app.get("/api/events/:id", async (req, res, next) => {
    try {
      const { id } = req.params;

      if (!/^[a-fA-F0-9]{24}$/.test(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid event ID",
        });
      }

      const event = await eventsCollection.findOne({
        _id: new ObjectId(id),
        status: "published",
      });

      if (!event) {
        return res.status(404).json({
          success: false,
          message: "Event not found",
        });
      }

      res.json({
        success: true,
        data: event,
      });
    } catch (error) {
      next(error);
    }
  });

  // Organizer sees own events; Admin sees all events.
app.get(
  "/api/manage/events",
  requireAuth,
  requireRole("organizer", "admin"),
  async (req, res, next) => {
    try {
      const filter =
        req.user.role === "admin"
          ? {}
          : { organizerId: req.user.id };

      const events = await eventsCollection
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();

      res.json({
        success: true,
        count: events.length,
        data: events,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Cancel an event without erasing its history.
app.delete(
  "/api/events/:id",
  requireAuth,
  requireRole("organizer", "admin"),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      if (!/^[a-fA-F0-9]{24}$/.test(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid event ID",
        });
      }

      const filter = {
        _id: new ObjectId(id),
      };

      if (req.user.role !== "admin") {
        filter.organizerId = req.user.id;
      }

      const event = await eventsCollection.findOne(filter);

      if (!event) {
        return res.status(404).json({
          success: false,
          message: "Event not found or you do not have permission",
        });
      }

      await eventsCollection.updateOne(
        filter,
        {
          $set: {
            status: "cancelled",
            updatedAt: new Date(),
          },
        }
      );

      res.json({
        success: true,
        message: "Event cancelled and removed from public listings",
      });
    } catch (error) {
      next(error);
    }
  }
);
// Read an event for editing.
app.get(
  "/api/manage/events/:id",
  requireAuth,
  requireRole("organizer", "admin"),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      if (!/^[a-fA-F0-9]{24}$/.test(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid event ID",
        });
      }

      const filter = {
        _id: new ObjectId(id),
      };

      if (req.user.role !== "admin") {
        filter.organizerId = req.user.id;
      }

      const event = await eventsCollection.findOne(filter);

      if (!event) {
        return res.status(404).json({
          success: false,
          message: "Event not found or you do not have permission",
        });
      }

      res.json({
        success: true,
        data: event,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Update event details.
app.patch(
  "/api/events/:id",
  requireAuth,
  requireRole("organizer", "admin"),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      if (!/^[a-fA-F0-9]{24}$/.test(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid event ID",
        });
      }

      const filter = {
        _id: new ObjectId(id),
      };

      if (req.user.role !== "admin") {
        filter.organizerId = req.user.id;
      }

      const existing = await eventsCollection.findOne(filter);

      if (!existing) {
        return res.status(404).json({
          success: false,
          message: "Event not found or you do not have permission",
        });
      }

      if (existing.status !== "published") {
        return res.status(409).json({
          success: false,
          message: "Only published events can be edited",
        });
      }

      const body = req.body || {};

      function validText(value, min, max) {
        return (
          typeof value === "string" &&
          value.trim().length >= min &&
          value.trim().length <= max
        );
      }

      if (
        !validText(body.title, 5, 150) ||
        !validText(body.description, 20, 5000) ||
        !validText(body.venue, 3, 200)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Check title (5–150), description (20–5000) and venue (3–200 characters).",
        });
      }

      const categories = [
        "Workshop",
        "Seminar",
        "Competition",
        "Cultural",
        "Sports",
        "Other",
      ];

      if (!categories.includes(body.category)) {
        return res.status(400).json({
          success: false,
          message: "Select a valid category",
        });
      }

      if (
        !Number.isInteger(body.capacity) ||
        body.capacity < 1 ||
        body.capacity > 100000
      ) {
        return res.status(400).json({
          success: false,
          message: "Capacity must be a whole number from 1 to 100000",
        });
      }

      if (
        typeof body.fee !== "number" ||
        !Number.isFinite(body.fee) ||
        body.fee < 0 ||
        body.fee > 1000000
      ) {
        return res.status(400).json({
          success: false,
          message: "Enter a valid fee from 0 to 1000000",
        });
      }

      // Dates, ownership and status remain unchanged in this edit form.
      const changes = {
        title: body.title.trim(),
        description: body.description.trim(),
        category: body.category,
        venue: body.venue.trim(),
        capacity: body.capacity,
        fee: body.fee,
        updatedAt: new Date(),
      };

      const result = await eventsCollection.updateOne(
  {
    ...filter,
    status: "published",

    // Capacity cannot be lower than existing registrations.
    $expr: {
      $lte: [
        { $ifNull: ["$registeredCount", 0] },
        body.capacity,
      ],
    },
  },
  { $set: changes }
);

     if (!result.matchedCount) {
  return res.status(409).json({
    success: false,
    message:
      "Update failed. Capacity cannot be below the registered count, or the event is no longer published. Reload and try again.",
  });
}

      res.json({
        success: true,
        message: "Event updated successfully",
      });
    } catch (error) {
      next(error);
    }
  }
);



// Register for an event.
app.post(
  "/api/events/:id/register",
  requireAuth,
  requireRole("student"),
  async (req, res, next) => {
    const { id } = req.params;

    if (!/^[a-fA-F0-9]{24}$/.test(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid event ID",
      });
    }

    const session = getMongoClient().startSession();

    function registrationError(status, message) {
      const error = new Error(message);
      error.status = status;
      return error;
    }

    try {
      await session.withTransaction(async () => {
        const existing = await registrationsCollection.findOne(
          {
            eventId: id,
            userId: req.user.id,
          },
          { session }
        );

        if (existing) {
          throw registrationError(
            409,
            "You are already registered for this event"
          );
        }

        const now = new Date();

        // Reserve one seat atomically within the transaction.
        const reservation = await eventsCollection.updateOne(
          {
            _id: new ObjectId(id),
            status: "published",
            registrationDeadline: { $gt: now },
            startDate: { $gt: now },
            $expr: {
              $lt: [
                { $ifNull: ["$registeredCount", 0] },
                "$capacity",
              ],
            },
          },
          {
            $inc: { registeredCount: 1 },
          },
          { session }
        );

        if (!reservation.matchedCount) {
          throw registrationError(
            409,
            "Registration is unavailable: event is full, closed, cancelled or missing"
          );
        }

        await registrationsCollection.insertOne(
          {
            eventId: id,
            userId: req.user.id,
            status: "registered",
            attended: false,
            createdAt: now,
          },
          { session }
        );
      });

      res.status(201).json({
        success: true,
        message: "Registration successful",
      });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({
          success: false,
          message: "You are already registered for this event",
        });
      }

      if (error.status) {
        return res.status(error.status).json({
          success: false,
          message: error.message,
        });
      }

      next(error);
    } finally {
      await session.endSession();
    }
  }
);

// Check the current user's registration.
app.get(
  "/api/events/:id/registration",
  requireAuth,
  async (req, res, next) => {
    try {
      const { id } = req.params;

      if (!/^[a-fA-F0-9]{24}$/.test(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid event ID",
        });
      }

      const registration = await registrationsCollection.findOne({
        eventId: id,
        userId: req.user.id,
      });

      res.json({
        success: true,
        data: registration,
      });
    } catch (error) {
      next(error);
    }
  }
);

// List the current user's registrations.
app.get(
  "/api/my-registrations",
  requireAuth,
  async (req, res, next) => {
    try {
      const registrations = await registrationsCollection
        .find(
          { userId: req.user.id },
          {
            projection: {
              attendanceToken: 0,
            },
          }
        )
        .sort({ createdAt: -1 })
        .toArray();

      const eventIds = [
        ...new Set(registrations.map((item) => item.eventId)),
      ]
        .filter((id) => /^[a-fA-F0-9]{24}$/.test(id))
        .map((id) => new ObjectId(id));

      const events = await eventsCollection
        .find(
          { _id: { $in: eventIds } },
          {
            projection: {
              title: 1,
              venue: 1,
              startDate: 1,
              status: 1,
            },
          }
        )
        .toArray();

      const eventMap = new Map(
        events.map((event) => [event._id.toString(), event])
      );

      res.json({
        success: true,
        data: registrations.map((registration) => ({
          ...registration,
          event: eventMap.get(registration.eventId) || null,
        })),
      });
    } catch (error) {
      next(error);
    }
  }
);

// Generate or retrieve the current user's ticket.
app.post(
  "/api/registrations/:id/ticket",
  requireAuth,
  async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");

      const { id } = req.params;

      if (!/^[a-fA-F0-9]{24}$/.test(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid registration ID",
        });
      }

      const filter = {
        _id: new ObjectId(id),
        userId: req.user.id,
        status: "registered",
      };

      const registration =
        await registrationsCollection.findOne(filter);

      if (!registration) {
        return res.status(404).json({
          success: false,
          message: "Registration not found",
        });
      }

      const event = await eventsCollection.findOne({
        _id: new ObjectId(registration.eventId),
        status: "published",
      });

      if (!event) {
        return res.status(409).json({
          success: false,
          message: "This event is no longer available",
        });
      }

      // Concurrent requests cannot replace an existing ticket token.
      await registrationsCollection.updateOne(
        {
          ...filter,
          attendanceToken: { $exists: false },
        },
        {
          $set: {
            attendanceToken: randomBytes(32).toString("hex"),
          },
        }
      );

      const ticket = await registrationsCollection.findOne(filter);

      if (!ticket?.attendanceToken) {
        return res.status(409).json({
          success: false,
          message: "Ticket unavailable. Please reload.",
        });
      }

      res.json({
        success: true,
        data: {
          registrationId: ticket._id,
          attendeeName: req.user.name,
          eventTitle: event.title,
          venue: event.venue,
          startDate: event.startDate,
          attended: ticket.attended,
          qrValue: `campus-events:${ticket.attendanceToken}`,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/attendance/check-in",
  requireAuth,
  requireRole("organizer", "admin"),
  async (req, res, next) => {
    const { qrValue } = req.body || {};

    if (
      typeof qrValue !== "string" ||
      !/^campus-events:[a-f0-9]{64}$/.test(qrValue)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid CampusEvents QR ticket",
      });
    }

    const token = qrValue.slice("campus-events:".length);
    const session = getMongoClient().startSession();

    function checkInError(status, message) {
      const error = new Error(message);
      error.status = status;
      return error;
    }

    let checkedIn;

    try {
      await session.withTransaction(async () => {
        const registration =
          await registrationsCollection.findOne(
            {
              attendanceToken: token,
              status: "registered",
            },
            { session }
          );

        if (!registration) {
          throw checkInError(404, "Ticket not found");
        }

        const eventFilter = {
          _id: new ObjectId(registration.eventId),
          status: "published",
        };

        if (req.user.role !== "admin") {
          eventFilter.organizerId = req.user.id;
        }

        const event = await eventsCollection.findOne(
          eventFilter,
          { session }
        );

        if (!event) {
          throw checkInError(
            403,
            "Event unavailable or you cannot manage this event"
          );
        }

        if (registration.attended) {
          throw checkInError(
            409,
            "This ticket has already been checked in"
          );
        }

        const now = new Date();

        const checkInOpens =
          new Date(event.startDate).getTime() - 60 * 60 * 1000;

        if (
          now.getTime() < checkInOpens ||
          now.getTime() > new Date(event.endDate).getTime()
        ) {
          throw checkInError(
            409,
            "Check-in is available from 1 hour before the event until it ends"
          );
        }

        // Writing the event also protects against concurrent cancellation.
        const eventUpdate = await eventsCollection.updateOne(
          eventFilter,
          { $inc: { attendanceCount: 1 } },
          { session }
        );

        if (!eventUpdate.matchedCount) {
          throw checkInError(409, "Event is no longer available");
        }

        const attendanceUpdate =
          await registrationsCollection.updateOne(
            {
              _id: registration._id,
              status: "registered",
              attended: { $ne: true },
            },
            {
              $set: {
                attended: true,
                attendedAt: now,
                checkedInBy: req.user.id,
              },
            },
            { session }
          );

        if (!attendanceUpdate.matchedCount) {
          throw checkInError(409, "Ticket already checked in");
        }

        checkedIn = {
          registrationId: registration._id,
          eventTitle: event.title,
          attendedAt: now,
        };
      });

      res.json({
        success: true,
        message: "Attendance recorded successfully",
        data: checkedIn,
      });
    } catch (error) {
      if (error.status) {
        return res.status(error.status).json({
          success: false,
          message: error.message,
        });
      }

      next(error);
    } finally {
      await session.endSession();
    }
  }
);
app.get(
  "/api/manage/events/:id/participants",
  requireAuth,
  requireRole("organizer", "admin"),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      if (!/^[a-fA-F0-9]{24}$/.test(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid event ID",
        });
      }

      const filter = {
        _id: new ObjectId(id),
      };

      if (req.user.role !== "admin") {
        filter.organizerId = req.user.id;
      }

      const event = await eventsCollection.findOne(filter);

      if (!event) {
        return res.status(404).json({
          success: false,
          message: "Event not found or you do not have permission",
        });
      }

      const registrations = await registrationsCollection
        .find(
          {
            eventId: id,
            status: "registered",
          },
          {
            projection: {
              userId: 1,
              attended: 1,
              attendedAt: 1,
              createdAt: 1,
            },
          }
        )
        .sort({ createdAt: -1 })
        .toArray();

      const userIds = [
        ...new Set(registrations.map((item) => item.userId)),
      ]
        .filter((userId) => /^[a-fA-F0-9]{24}$/.test(userId))
        .map((userId) => new ObjectId(userId));

      const users = await db
        .collection("user")
        .find(
          { _id: { $in: userIds } },
          {
            projection: {
              name: 1,
              email: 1,
            },
          }
        )
        .toArray();

      const userMap = new Map(
        users.map((user) => [user._id.toString(), user])
      );

      const participants = registrations.map((registration) => {
        const user = userMap.get(registration.userId);

        return {
          registrationId: registration._id,
          name: user?.name || "Unavailable user",
          email: user?.email || "",
          registeredAt: registration.createdAt,
          attended: registration.attended === true,
          attendedAt: registration.attendedAt || null,
        };
      });

      const attended = participants.filter(
        (participant) => participant.attended
      ).length;

      res.json({
        success: true,
        data: {
          event: {
            id: event._id,
            title: event.title,
            status: event.status,
            capacity: event.capacity,
          },
          summary: {
            registered: participants.length,
            attended,
            notCheckedIn: participants.length - attended,
          },
          participants,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/registrations/:id/certificate",
  requireAuth,
  async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");

      const { id } = req.params;

      if (!/^[a-fA-F0-9]{24}$/.test(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid registration ID",
        });
      }

      const filter = {
        _id: new ObjectId(id),
        userId: req.user.id,
        status: "registered",
        attended: true,
      };

      const registration =
        await registrationsCollection.findOne(filter);

      if (!registration) {
        return res.status(403).json({
          success: false,
          message: "You must attend this event to receive a certificate",
        });
      }

      const event = await eventsCollection.findOne({
        _id: new ObjectId(registration.eventId),
        status: "published",
      });

      if (!event) {
        return res.status(409).json({
          success: false,
          message: "Certificate is unavailable for this event",
        });
      }

      if (
        !event.endDate ||
        new Date(event.endDate).getTime() > Date.now()
      ) {
        return res.status(409).json({
          success: false,
          message: "Certificate will be available after the event ends",
        });
      }

      // Save a stable certificate snapshot only once.
      await registrationsCollection.updateOne(
        {
          ...filter,
          certificate: { $exists: false },
        },
        {
          $set: {
            certificate: {
              certificateId: `CE-${registration._id.toString()}`,
              attendeeName: req.user.name,
              eventTitle: event.title,
              eventDate: event.startDate,
              issuedAt: new Date(),
            },
          },
        }
      );

      const updated =
        await registrationsCollection.findOne(filter);

      if (!updated?.certificate) {
        return res.status(409).json({
          success: false,
          message: "Certificate unavailable. Please reload.",
        });
      }

      res.json({
        success: true,
        data: updated.certificate,
      });
    } catch (error) {
      next(error);
    }
  }
);


// Current user's favorites.
app.get("/api/favorites", requireAuth, async (req, res, next) => {
  try {
    const favorites = await favoritesCollection
      .find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .toArray();

    const eventIds = favorites.map(
      (favorite) => new ObjectId(favorite.eventId)
    );

    const events = await eventsCollection
      .find(
        { _id: { $in: eventIds }, status: "published" },
        {
          projection: {
            title: 1,
            category: 1,
            venue: 1,
            startDate: 1,
          },
        }
      )
      .toArray();

    const eventMap = new Map(
      events.map((event) => [event._id.toString(), event])
    );

    res.json({
      success: true,
      data: favorites.map((favorite) => ({
        eventId: favorite.eventId,
        event: eventMap.get(favorite.eventId) || null,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// Add a favorite. Repeating the request is safe.
app.put(
  "/api/favorites/:eventId",
  requireAuth,
  async (req, res, next) => {
    try {
      const { eventId } = req.params;

      if (!/^[a-fA-F0-9]{24}$/.test(eventId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid event ID",
        });
      }

      const canonicalId = new ObjectId(eventId).toString();

      const event = await eventsCollection.findOne({
        _id: new ObjectId(canonicalId),
        status: "published",
      });

      if (!event) {
        return res.status(404).json({
          success: false,
          message: "Event unavailable",
        });
      }

      try {
        await favoritesCollection.updateOne(
          {
            userId: req.user.id,
            eventId: canonicalId,
          },
          {
            $setOnInsert: {
              createdAt: new Date(),
            },
          },
          { upsert: true }
        );
      } catch (error) {
        // A concurrent identical request may insert it first.
        if (error.code !== 11000) throw error;
      }

      res.json({
        success: true,
        message: "Event saved to favorites",
      });
    } catch (error) {
      next(error);
    }
  }
);

// Remove only the current user's favorite.
app.delete(
  "/api/favorites/:eventId",
  requireAuth,
  async (req, res, next) => {
    try {
      const { eventId } = req.params;

      if (!/^[a-fA-F0-9]{24}$/.test(eventId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid event ID",
        });
      }

      await favoritesCollection.deleteOne({
        userId: req.user.id,
        eventId: new ObjectId(eventId).toString(),
      });

      res.json({
        success: true,
        message: "Favorite removed",
      });
    } catch (error) {
      next(error);
    }
  }
);


// Public reviews and average rating.
app.get("/api/events/:id/reviews", async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!/^[a-fA-F0-9]{24}$/.test(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid event ID",
      });
    }

    const eventId = new ObjectId(id).toString();

    const event = await eventsCollection.findOne({
      _id: new ObjectId(eventId),
      status: "published",
    });

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event unavailable",
      });
    }

    const reviews = await reviewsCollection
      .find(
        { eventId },
        {
          projection: {
            userId: 1,
            name: 1,
            rating: 1,
            comment: 1,
            updatedAt: 1,
          },
        }
      )
      .sort({ updatedAt: -1, _id: -1 })
      .toArray();

    const total = reviews.length;

    const average = total
      ? reviews.reduce((sum, review) => sum + review.rating, 0) / total
      : 0;

    res.json({
      success: true,
      data: {
        reviews,
        total,
        average,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Create or update the current user's review.
app.put(
  "/api/events/:id/review",
  requireAuth,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { rating, comment } = req.body || {};

      if (!/^[a-fA-F0-9]{24}$/.test(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid event ID",
        });
      }

      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return res.status(400).json({
          success: false,
          message: "Rating must be a whole number from 1 to 5",
        });
      }

      if (
        typeof comment !== "string" ||
        comment.trim().length < 5 ||
        comment.trim().length > 1000
      ) {
        return res.status(400).json({
          success: false,
          message: "Review must contain 5 to 1000 characters",
        });
      }

      const eventId = new ObjectId(id).toString();

      const event = await eventsCollection.findOne({
        _id: new ObjectId(eventId),
        status: "published",
      });

      if (!event) {
        return res.status(404).json({
          success: false,
          message: "Event unavailable",
        });
      }

      const endTime = new Date(event.endDate).getTime();

      if (!Number.isFinite(endTime) || endTime > Date.now()) {
        return res.status(409).json({
          success: false,
          message: "You can review this event after it ends",
        });
      }

      const registration = await registrationsCollection.findOne({
        eventId,
        userId: req.user.id,
        status: "registered",
        attended: true,
      });

      if (!registration) {
        return res.status(403).json({
          success: false,
          message: "Only attended participants can review this event",
        });
      }

      const filter = {
        eventId,
        userId: req.user.id,
      };

      const changes = {
        name: req.user.name,
        rating,
        comment: comment.trim(),
        updatedAt: new Date(),
      };

      try {
        await reviewsCollection.updateOne(
          filter,
          {
            $set: changes,
            $setOnInsert: { createdAt: new Date() },
          },
          { upsert: true }
        );
      } catch (error) {
        if (error.code !== 11000) throw error;

        // Another simultaneous request created the same user's review.
        await reviewsCollection.updateOne(
          filter,
          { $set: changes }
        );
      }

      res.json({
        success: true,
        message: "Review saved successfully",
      });
    } catch (error) {
      next(error);
    }
  }
);

// Delete only the current user's review.
app.delete(
  "/api/events/:id/review",
  requireAuth,
  async (req, res, next) => {
    try {
      const { id } = req.params;

      if (!/^[a-fA-F0-9]{24}$/.test(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid event ID",
        });
      }

      await reviewsCollection.deleteOne({
        eventId: new ObjectId(id).toString(),
        userId: req.user.id,
      });

      res.json({
        success: true,
        message: "Review deleted",
      });
    } catch (error) {
      next(error);
    }
  }
);


app.get(
  "/api/admin/users",
  requireAuth,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const search =
        typeof req.query.search === "string"
          ? req.query.search.trim()
          : "";

      const page = Number(req.query.page ?? 1);
      const limit = 10;

      if (
        search.length > 100 ||
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 100000
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid search or page",
        });
      }

      const filter = {};

      if (search) {
        const escaped = search.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        );

        filter.$or = [
          { name: { $regex: escaped, $options: "i" } },
          { email: { $regex: escaped, $options: "i" } },
        ];
      }

      const usersCollection = db.collection("user");

      const [users, total] = await Promise.all([
        usersCollection
          .find(filter, {
            projection: {
              name: 1,
              email: 1,
              createdAt: 1,
            },
          })
          .sort({ createdAt: -1, _id: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),

        usersCollection.countDocuments(filter),
      ]);

      const userIds = users.map((user) => user._id.toString());

      const roleRecords = await rolesCollection
        .find({ userId: { $in: userIds } })
        .toArray();

      const roleMap = new Map(
        roleRecords.map((record) => [record.userId, record.role])
      );

      res.json({
        success: true,
        data: users.map((user) => {
          const id = user._id.toString();

          return {
            id,
            name: user.name,
            email: user.email,
            createdAt: user.createdAt,
            role: roleMap.get(id) || "student",
          };
        }),
        currentUserId: req.user.id,
        total,
        page,
        totalPages: Math.ceil(total / limit),
      });
    } catch (error) {
      next(error);
    }
  }
);
app.get(
  "/api/dashboard/summary",
  requireAuth,
  async (req, res, next) => {
    try {
      const { id: userId, role } = req.user;

      if (role === "student") {
        const [
          registered,
          attended,
          certificates,
          favorites,
        ] = await Promise.all([
          registrationsCollection.countDocuments({
            userId,
            status: "registered",
          }),

          registrationsCollection.countDocuments({
            userId,
            status: "registered",
            attended: true,
          }),

          registrationsCollection.countDocuments({
            userId,
            certificate: { $exists: true },
          }),

          favoritesCollection.countDocuments({ userId }),
        ]);

        return res.json({
          success: true,
          data: {
            role,
            stats: {
              registered,
              attended,
              certificates,
              favorites,
            },
            events: [],
          },
        });
      }

      if (!["organizer", "admin"].includes(role)) {
        return res.status(403).json({
          success: false,
          message: "You do not have permission",
        });
      }

      const filter =
        role === "admin" ? {} : { organizerId: userId };

      const events = await eventsCollection
        .find(filter, {
          projection: {
            title: 1,
            status: 1,
            capacity: 1,
            startDate: 1,
            registeredCount: 1,
            attendanceCount: 1,
          },
        })
        .sort({ startDate: -1, _id: -1 })
        .toArray();

      const stats = {
        totalEvents: events.length,
        publishedEvents: 0,
        cancelledEvents: 0,
        registrations: 0,
        attendance: 0,
      };

      for (const event of events) {
        if (event.status === "published") {
          stats.publishedEvents += 1;
        }

        if (event.status === "cancelled") {
          stats.cancelledEvents += 1;
        }

        stats.registrations += event.registeredCount || 0;
        stats.attendance += event.attendanceCount || 0;
      }

      if (role === "admin") {
        stats.totalUsers = await db
          .collection("user")
          .countDocuments();
      }

      const eventAnalytics = events.map((event) => {
        const registered = event.registeredCount || 0;
        const attended = event.attendanceCount || 0;

        return {
          id: event._id.toString(),
          title: event.title,
          status: event.status,
          capacity: event.capacity,
          registered,
          attended,
          attendanceRate:
            registered > 0
              ? Math.round((attended / registered) * 100)
              : 0,
        };
      });

      res.json({
        success: true,
        data: {
          role,
          stats,
          events: eventAnalytics,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Latest notifications for the current user.
app.get(
  "/api/notifications",
  requireAuth,
  async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");

      const [notifications, unreadCount] = await Promise.all([
        notificationsCollection
          .find(
            { userId: req.user.id },
            {
              projection: {
                title: 1,
                message: 1,
                href: 1,
                read: 1,
                createdAt: 1,
              },
            }
          )
          .sort({ createdAt: -1, _id: -1 })
          .limit(50)
          .toArray(),

        notificationsCollection.countDocuments({
          userId: req.user.id,
          read: false,
        }),
      ]);

      res.json({
        success: true,
        data: notifications,
        unreadCount,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Mark one of the current user's notifications as read.
app.patch(
  "/api/notifications/:id/read",
  requireAuth,
  async (req, res, next) => {
    try {
      const { id } = req.params;

      if (!/^[a-fA-F0-9]{24}$/.test(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid notification ID",
        });
      }

      const result = await notificationsCollection.updateOne(
        {
          _id: new ObjectId(id),
          userId: req.user.id,
        },
        {
          $set: { read: true },
        }
      );

      if (!result.matchedCount) {
        return res.status(404).json({
          success: false,
          message: "Notification not found",
        });
      }

      res.json({
        success: true,
        message: "Notification marked as read",
      });
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/recommendations",
  requireAuth,
  async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");

      const userId = req.user.id;

      const [favorites, registrations] = await Promise.all([
        favoritesCollection
          .find({ userId }, { projection: { eventId: 1 } })
          .toArray(),

        registrationsCollection
          .find(
            { userId, status: "registered" },
            { projection: { eventId: 1 } }
          )
          .toArray(),
      ]);

      const registeredIds = new Set(
        registrations.map((item) => item.eventId)
      );

      const historyIds = [
        ...new Set(
          [...favorites, ...registrations].map(
            (item) => item.eventId
          )
        ),
      ]
        .filter(
          (id) =>
            typeof id === "string" &&
            /^[a-fA-F0-9]{24}$/.test(id)
        )
        .map((id) => new ObjectId(id));

      const now = new Date();

      const [history, availableEvents] = await Promise.all([
        eventsCollection
          .find(
            { _id: { $in: historyIds } },
            {
              projection: {
                title: 1,
                description: 1,
                category: 1,
              },
            }
          )
          .toArray(),

        eventsCollection
          .find({
            status: "published",
            startDate: { $gt: now },
            registrationDeadline: { $gt: now },
            $expr: {
              $lt: [
                { $ifNull: ["$registeredCount", 0] },
                "$capacity",
              ],
            },
          })
          .sort({ startDate: 1, _id: 1 })
          .limit(200)
          .toArray(),
      ]);

      const candidates = availableEvents.filter(
        (event) => !registeredIds.has(event._id.toString())
      );

      const ranked = rankEvents(candidates, history);
      const hasMatches = ranked.some((item) => item.score > 0);

      res.json({
        success: true,
        mode: hasMatches ? "personalized" : "upcoming",
        data: ranked.slice(0, 6).map(({ event, reason }) => ({
          id: event._id.toString(),
          title: event.title,
          category: event.category,
          venue: event.venue,
          startDate: event.startDate,
          fee: event.fee,
          reason,
        })),
      });
    } catch (error) {
      next(error);
    }
  }
);
  // Unknown route.
  app.use((req, res) => {
    res.status(404).json({
      success: false,
      message: "Route not found",
    });
  });

  // Error handler.
  app.use((error, req, res, next) => {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  });

  const server = app.listen(port, () => {
    console.log(`Campus Events API: http://localhost:${port}`);
  });
  const stopNotificationWorker = startNotificationWorker(db);
  stopNotificationWorker();

  async function shutdown() {
  stopNotificationWorker();

  server.close(async () => {
    await closeDB();
    process.exit(0);
  });
}

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

startServer().catch(async (error) => {
  console.error("Server startup failed:", error.message);
  await closeDB();
  process.exit(1);
});