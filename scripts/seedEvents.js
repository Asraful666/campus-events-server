import { connectDB, closeDB } from "../config/db.js";

const demoEvents = [
  {
    seedKey: "demo-web-development-workshop",
    title: "Web Development Workshop",
    description:
      "A beginner-friendly workshop about HTML, CSS, JavaScript and React.",
    category: "Workshop",
    venue: "Computer Lab",
    startDate: new Date("2026-12-10T10:00:00+06:00"),
    endDate: new Date("2026-12-10T13:00:00+06:00"),
    registrationDeadline: new Date("2026-12-09T23:59:00+06:00"),
    capacity: 60,
    fee: 0,
    status: "published",
  },
  {
    seedKey: "demo-campus-programming-contest",
    title: "Campus Programming Contest",
    description:
      "Solve programming problems and compete with other students.",
    category: "Competition",
    venue: "CSE Department",
    startDate: new Date("2026-12-15T09:00:00+06:00"),
    endDate: new Date("2026-12-15T14:00:00+06:00"),
    registrationDeadline: new Date("2026-12-13T23:59:00+06:00"),
    capacity: 100,
    fee: 0,
    status: "published",
  },
  {
    seedKey: "demo-ai-career-seminar",
    title: "AI and Career Seminar",
    description:
      "An introduction to artificial intelligence and career preparation.",
    category: "Seminar",
    venue: "University Auditorium",
    startDate: new Date("2026-12-20T11:00:00+06:00"),
    endDate: new Date("2026-12-20T13:00:00+06:00"),
    registrationDeadline: new Date("2026-12-19T23:59:00+06:00"),
    capacity: 200,
    fee: 0,
    status: "published",
  },
];

try {
  const db = await connectDB();
  const collection = db.collection("events");

  // Running the script again will not duplicate these events.
  for (const event of demoEvents) {
    await collection.updateOne(
      { seedKey: event.seedKey },
      {
        $setOnInsert: {
          ...event,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
  }

  console.log("Demo events are ready");
} catch (error) {
  console.error("Seeding failed:", error.message);
  process.exitCode = 1;
} finally {
  await closeDB();
}