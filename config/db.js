import { MongoClient, ServerApiVersion } from "mongodb";
import "dotenv/config";

let client;
let database;

export async function connectDB() {
  if (database) {
    return database;
  }

  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is missing in .env");
  }

  client = new MongoClient(process.env.MONGODB_URI, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
  });

  await client.connect();

  database = client.db(
    process.env.MONGODB_DB_NAME || "campus_events"
  );

  await database.command({ ping: 1 });

  console.log("MongoDB connected successfully");

  return database;
}

export async function closeDB() {
  if (client) {
    await client.close();
  }
}
export function getMongoClient() {
  if (!client) {
    throw new Error("Database is not connected");
  }

  return client;
}