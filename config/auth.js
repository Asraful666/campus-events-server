import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { jwt } from "better-auth/plugins";

export function createAuth(db) {
  if (!process.env.BETTER_AUTH_SECRET) {
    throw new Error("BETTER_AUTH_SECRET is missing");
  }

  return betterAuth({
    appName: "CampusEvents",

    baseURL: process.env.BETTER_AUTH_URL,
    secret: process.env.BETTER_AUTH_SECRET,

    database: mongodbAdapter(db),

    trustedOrigins: [
      process.env.CLIENT_URL || "http://localhost:3000",
    ],

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },

    plugins: [
  jwt({
    jwt: {
      issuer: process.env.BETTER_AUTH_URL,
      audience: process.env.BETTER_AUTH_URL,
      expirationTime: "5m",
    },
  }),
],
  });
}