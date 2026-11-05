import { connectDB, closeDB } from "../config/db.js";

try {
  const email = process.argv[2]?.trim();

  if (!email) {
    throw new Error(
      "Usage: node scripts/makeAdmin.js your-email@example.com"
    );
  }

  const db = await connectDB();

  const user = await db.collection("user").findOne({ email });

  if (!user) {
    throw new Error(
      "Account not found. Register first and use the same email."
    );
  }

  const userId = user._id.toString();

  await db.collection("user_roles").createIndex(
    { userId: 1 },
    { unique: true }
  );

  await db.collection("user_roles").updateOne(
    { userId },
    {
      $set: {
        role: "admin",
        updatedAt: new Date(),
      },
      $setOnInsert: {
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );

  console.log(`Admin role assigned to ${user.email}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await closeDB();
}