import { ObjectId } from "mongodb";

export function startNotificationWorker(db) {
  const notifications = db.collection("notifications");
  const registrations = db.collection("registrations");
  const events = db.collection("events");

  let running = false;
  let stopped = false;

  async function saveNotification({
    key,
    userId,
    title,
    message,
    href,
  }) {
    try {
      await notifications.updateOne(
        { key },
        {
          $setOnInsert: {
            userId,
            title,
            message,
            href,
            read: false,
            createdAt: new Date(),
          },
        },
        { upsert: true }
      );
    } catch (error) {
      // Another worker may have inserted the same notification.
      if (error.code !== 11000) throw error;
    }
  }

  async function run() {
    if (running || stopped) return;

    running = true;

    try {
      const cursor = registrations.find({
        status: "registered",
      });

      try {
        for await (const registration of cursor) {
          if (stopped) break;

          if (
            typeof registration.eventId !== "string" ||
            !/^[a-fA-F0-9]{24}$/.test(registration.eventId)
          ) {
            continue;
          }

          const event = await events.findOne({
            _id: new ObjectId(registration.eventId),
          });

          if (!event) continue;

          const registrationId = registration._id.toString();

          if (event.status === "cancelled") {
            await saveNotification({
              key: `cancelled:${registrationId}`,
              userId: registration.userId,
              title: "Event cancelled",
              message: `${event.title} has been cancelled.`,
              href: "/dashboard/my-registrations",
            });

            continue;
          }

          if (event.status !== "published") continue;

          const startTime = new Date(event.startDate).getTime();

          // Historical events do not generate fresh registration alerts.
          if (!Number.isFinite(startTime) || startTime <= Date.now()) {
            continue;
          }

          await saveNotification({
            key: `registered:${registrationId}`,
            userId: registration.userId,
            title: "Registration confirmed",
            message: `You are registered for ${event.title}.`,
            href: "/dashboard/my-registrations",
          });

          const hoursUntilStart =
            (startTime - Date.now()) / (60 * 60 * 1000);

          if (hoursUntilStart > 0 && hoursUntilStart <= 24) {
            const startLabel = new Intl.DateTimeFormat("en-GB", {
              dateStyle: "medium",
              timeStyle: "short",
              timeZone: "Asia/Dhaka",
            }).format(new Date(event.startDate));

            await saveNotification({
              key: `reminder:${registrationId}:${startTime}`,
              userId: registration.userId,
              title: "Upcoming event reminder",
              message:
                `${event.title} starts on ${startLabel} ` +
                `(Bangladesh time) at ${event.venue}.`,
              href: "/dashboard/my-registrations",
            });
          }
        }
      } finally {
        await cursor.close();
      }
    } catch (error) {
      console.error("Notification worker failed:", error.message);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    void run();
  }, 60_000);

  void run();

  return function stopNotificationWorker() {
    stopped = true;
    clearInterval(timer);
  };
}