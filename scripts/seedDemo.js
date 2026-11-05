import "dotenv/config";
import { ObjectId } from "mongodb";
import { randomBytes } from "node:crypto";
import { connectDB, closeDB } from "../config/db.js";
import { createAuth } from "../config/auth.js";

const password = process.env.DEMO_PASSWORD;

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

async function main() {
  if (
    !password ||
    password === "YOUR_DEMO_PASSWORD_HERE" ||
    password.length < 8 ||
    password.length > 128
  ) {
    throw new Error(
      "Set DEMO_PASSWORD in .env to a password between 8 and 128 characters."
    );
  }

  const db = await connectDB();
  const auth = createAuth(db);

  const users = db.collection("user");
  const roles = db.collection("user_roles");
  const events = db.collection("events");
  const registrations = db.collection("registrations");

  await roles.createIndex({ userId: 1 }, { unique: true });

  await registrations.createIndex(
    { eventId: 1, userId: 1 },
    { unique: true }
  );

  await registrations.createIndex(
    { attendanceToken: 1 },
    { unique: true, sparse: true }
  );

  // Existing accounts keep their current passwords.
  async function ensureUser(name, email, role) {
    let user = await users.findOne({ email });

    if (!user) {
      await auth.api.signUpEmail({
        body: {
          name,
          email,
          password,
        },
      });

      user = await users.findOne({ email });

      if (!user) {
        throw new Error(`Could not create account: ${email}`);
      }

      console.log(`Created account: ${email}`);
    } else {
      console.log(`Existing account: ${email}`);
    }

    const userId = user._id.toString();

    await roles.updateOne(
      { userId },
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

    return {
      id: userId,
      name: user.name,
      email: user.email,
    };
  }

  const admin = await ensureUser(
    "Demo Admin",
    "admin@campusevents.example",
    "admin"
  );

  const organizer = await ensureUser(
    "Demo Organizer",
    "organizer@campusevents.example",
    "organizer"
  );

  const student = await ensureUser(
    "Demo Student",
    "student@campusevents.example",
    "student"
  );

  const secondStudent = await ensureUser(
    "Demo Student Two",
    "student2@campusevents.example",
    "student"
  );

  // A fresh batch is created each run, with dates relative to that run.
  const batchId = new ObjectId().toString();

  async function createEvent({
    title,
    description,
    category,
    venue,
    startHours,
    endHours,
    deadlineHours,
    capacity = 30,
    status = "published",
  }) {
    const event = {
      _id: new ObjectId(),
      title,
      description,
      category,
      venue,
      startDate: hoursFromNow(startHours),
      endDate: hoursFromNow(endHours),
      registrationDeadline: hoursFromNow(deadlineHours),
      capacity,
      fee: 0,
      organizerId: organizer.id,
      status,
      registeredCount: 0,
      attendanceCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      demoBatchId: batchId,
    };

    await events.insertOne(event);
    return event;
  }

  async function addRegistration(event, user, attended = false) {
    const registration = {
      eventId: event._id.toString(),
      userId: user.id,
      status: "registered",
      attended,
      attendanceToken: randomBytes(32).toString("hex"),
      createdAt: new Date(
        event.startDate.getTime() - 24 * 60 * 60 * 1000
      ),
      demoBatchId: batchId,
    };

    if (attended) {
      registration.attendedAt = new Date(
        event.startDate.getTime() + 10 * 60 * 1000
      );

      registration.checkedInBy = admin.id;
    }

    await registrations.insertOne(registration);

    await events.updateOne(
      { _id: event._id },
      {
        $inc: {
          registeredCount: 1,
          attendanceCount: attended ? 1 : 0,
        },
      }
    );
  }

  const certificateEvent = await createEvent({
    title: "DEMO - Completed React Workshop",
    description:
      "A completed practical React workshop for testing attendance records and certificate generation.",
    category: "Workshop",
    venue: "CSE Computer Lab",
    startHours: -48,
    endHours: -45,
    deadlineHours: -50,
  });

  await addRegistration(certificateEvent, student, true);
  await addRegistration(certificateEvent, secondStudent, true);

  const attendanceEvent = await createEvent({
    title: "DEMO - QR Attendance Test",
    description:
      "An active check-in test event. Upload a registered student's QR ticket to record attendance.",
    category: "Seminar",
    venue: "Main Auditorium",
    startHours: 0.5,
    endHours: 3,
    deadlineHours: 0.25,
  });

  await addRegistration(attendanceEvent, student);
  await addRegistration(attendanceEvent, secondStudent);

  const upcomingEvent = await createEvent({
    title: "DEMO - AI Career Seminar",
    description:
      "Explore artificial intelligence, machine learning and career opportunities with campus speakers.",
    category: "Seminar",
    venue: "Seminar Hall",
    startHours: 72,
    endHours: 75,
    deadlineHours: 48,
    capacity: 100,
  });

  await addRegistration(upcomingEvent, student);

  const fullEvent = await createEvent({
    title: "DEMO - Full Programming Contest",
    description:
      "A programming contest with all seats reserved for testing the capacity limit.",
    category: "Competition",
    venue: "Programming Lab",
    startHours: 96,
    endHours: 100,
    deadlineHours: 80,
    capacity: 1,
  });

  await addRegistration(fullEvent, secondStudent);

  const cancelledEvent = await createEvent({
    title: "DEMO - Cancelled Cultural Event",
    description:
      "A cancelled campus cultural event for testing registration history and unavailable tickets.",
    category: "Cultural",
    venue: "Open Stage",
    startHours: 120,
    endHours: 123,
    deadlineHours: 96,
    status: "cancelled",
  });

  await addRegistration(cancelledEvent, student);

  const missedEvent = await createEvent({
    title: "DEMO - Completed Event Without Attendance",
    description:
      "A completed seminar where the student registered but did not attend, for certificate eligibility testing.",
    category: "Seminar",
    venue: "Lecture Hall",
    startHours: -24,
    endHours: -22,
    deadlineHours: -26,
  });

  await addRegistration(missedEvent, student);

  await createEvent({
    title: "DEMO - Campus Sports Meetup",
    description:
      "Join students for a friendly sports meetup and team activities on the campus field.",
    category: "Sports",
    venue: "University Field",
    startHours: 144,
    endHours: 147,
    deadlineHours: 120,
  });

  await createEvent({
    title: "DEMO - UI Design Workshop",
    description:
      "Learn interface design basics, accessible layouts and practical prototyping techniques.",
    category: "Workshop",
    venue: "Design Lab",
    startHours: 168,
    endHours: 171,
    deadlineHours: 144,
  });

  await createEvent({
    title: "DEMO - Campus Networking Day",
    description:
      "Meet fellow students and share project ideas during a campus networking session.",
    category: "Other",
    venue: "Student Center",
    startHours: 192,
    endHours: 195,
    deadlineHours: 168,
  });

  console.log("");
  console.log("Demo data created successfully.");
  console.log(`Batch ID: ${batchId}`);
  console.log("Events: 9");
  console.log("Registrations: 9");
  console.log("");
  console.log("Demo accounts:");
  console.log(admin.email);
  console.log(organizer.email);
  console.log(student.email);
  console.log(secondStudent.email);
  console.log("");
  console.log("New accounts use DEMO_PASSWORD from .env.");
  console.log("Existing accounts retain their original passwords.");
  console.log("");
  console.log("Certificate test: DEMO - Completed React Workshop");
  console.log("QR test: DEMO - QR Attendance Test");
}

try {
  await main();
} catch (error) {
  console.error("Demo seed failed:", error.message);
  process.exitCode = 1;
} finally {
  await closeDB();
}