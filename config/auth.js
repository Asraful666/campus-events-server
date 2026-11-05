import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { jwt } from "better-auth/plugins";

export function createAuth(db) {
  const secret = process.env.BETTER_AUTH_SECRET;
  const authURL = process.env.BETTER_AUTH_URL?.replace(/\/+$/, "");
  const clientURL = process.env.CLIENT_URL?.replace(/\/+$/, "");

  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is missing");
  }

  if (!authURL) {
    throw new Error("BETTER_AUTH_URL is missing");
  }

  if (!clientURL) {
    throw new Error("CLIENT_URL is missing");
  }

  return betterAuth({
    appName: "CampusEvents",

    baseURL: authURL,
    basePath: "/api/auth",
    secret,

    database: mongodbAdapter(db),

    trustedOrigins: [clientURL],

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },

    plugins: [
      jwt({
        jwt: {
          issuer: authURL,
          audience: authURL,
          expirationTime: "5m",
        },
      }),
    ],
  });
}