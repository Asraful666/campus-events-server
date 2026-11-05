import { createRemoteJWKSet, jwtVerify } from "jose";
import { fromNodeHeaders } from "better-auth/node";

export function createAuthMiddleware(auth, db) {
  const issuer = process.env.BETTER_AUTH_URL;

  const jwks = createRemoteJWKSet(
    new URL("/api/auth/jwks", issuer)
  );

  async function requireAuth(req, res, next) {
    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Login is required",
      });
    }

    let payload;

    try {
      const token = authorization.slice(7);

      const result = await jwtVerify(token, jwks, {
        issuer,
        audience: issuer,
      });

      payload = result.payload;
    } catch {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired token",
      });
    }

    try {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
      });

      if (!session || payload.sub !== session.user.id) {
        return res.status(401).json({
          success: false,
          message: "Your session has expired. Please login again.",
        });
      }

      const roleRecord = await db
        .collection("user_roles")
        .findOne({ userId: session.user.id });

      req.user = {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        role: roleRecord?.role || "student",
      };

      next();
    } catch (error) {
      next(error);
    }
  }

  function requireRole(...allowedRoles) {
    return (req, res, next) => {
      if (!req.user || !allowedRoles.includes(req.user.role)) {
        return res.status(403).json({
          success: false,
          message: "You do not have permission",
        });
      }

      next();
    };
  }

  return { requireAuth, requireRole };
}