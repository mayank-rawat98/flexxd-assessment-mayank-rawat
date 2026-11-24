const crypto = require('crypto');
const express = require('express');

const app = express();
app.use(express.json());

// In-memory store
const users = new Map(); // userId -> { id, name, credits }
const venues = new Map(); // venueId -> { id, name, price, dailyCapacity }
const bookings = new Map(); // bookingId -> booking
const bookingIdByCode = new Map(); // redemptionCode -> bookingId

// Every time read goes through clock.now() (ms since epoch). Tests can replace it to move the clock,
// e.g. clock.now = () => start + 11 * 60 * 1000. seed() puts the real clock back.
const realNow = () => Date.now();
const clock = { now: realNow };

// Clears everything, restores the real clock and loads the seed data. Call in tests (e.g. beforeEach) for a clean slate.
function seed() {
  clock.now = realNow;
  users.clear();
  venues.clear();
  bookings.clear();
  bookingIdByCode.clear();

  users.set('u1', { id: 'u1', name: 'Alice', credits: 2 });
  users.set('u2', { id: 'u2', name: 'Bob', credits: 0 });

  venues.set('v1', { id: 'v1', name: 'Downtown Gym', price: 1, dailyCapacity: 2 });
  venues.set('v2', { id: 'v2', name: 'Riverside Yoga', price: 1, dailyCapacity: 5 });
}

seed();

function sendError( res, status, code, message){
  return res.status(status).json({ error: { code, message } });
}

// No 0/O or 1/I/L, so codes are easy to read out loud. 31^8 ≈ 8.5e11 combinations.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;
const CODE_TTL_MS = 10 * 60 * 1000; // a redemption code is valid for 10 minutes after booking

function generateRedemptionCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
  } while (bookingIdByCode.has(code));
  return code;
}

const utcDay = (isoString) => isoString.slice(0, 10); // "YYYY-MM-DD"

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

app.post('/bookings', (req, res) => {
  const { userId, venueId } = req.body ?? {};

  if (!isNonEmptyString(userId) || !isNonEmptyString(venueId)) {
    return sendError(res, 400, 'INVALID_REQUEST', 'userId and venueId are required non-empty strings');
  }

  const user = users.get(userId);
  if (!user) {
    return sendError(res, 404, 'USER_NOT_FOUND', 'User not found');
  }

  const venue = venues.get(venueId);
  if (!venue) {
    return sendError(res, 404, 'VENUE_NOT_FOUND', 'Venue not found');
  }

  if (user.credits < 1) {
    return sendError(res, 409, 'INSUFFICIENT_CREDITS', 'Insufficient credits');
  }

  // One timestamp for both the capacity check and createdAt, so they agree on the day at UTC midnight.
  const now = clock.now();
  const createdAt = new Date(now).toISOString();
  const today = utcDay(createdAt);
  let bookedToday = 0;
  for (const booking of bookings.values()) {
    if (booking.venueId === venueId && utcDay(booking.createdAt) === today) bookedToday++;
  }
  if (bookedToday >= venue.dailyCapacity) {
    return sendError(res, 409, 'VENUE_AT_CAPACITY', 'Venue is at capacity for today');
  }

  // All checks passed. The handler is synchronous, so nothing can run between the checks and these writes.
  user.credits -= 1;

  const booking = {
    id: crypto.randomUUID(),
    userId,
    venueId,
    status: 'booked',
    createdAt,
    expiresAt: new Date(now + CODE_TTL_MS).toISOString(),
    redemptionCode: generateRedemptionCode(),
  };
  bookings.set(booking.id, booking);
  bookingIdByCode.set(booking.redemptionCode, booking.id);

  return res.status(201).json(booking);
});

app.post('/bookings/redeem', (req, res) => {
  const { code } = req.body ?? {};

  if (!isNonEmptyString(code)) {
    return sendError(res, 400, 'INVALID_REQUEST', 'code is a required non-empty string');
  }

  // Codes are generated uppercase; accept lowercase or padded input from people typing them in.
  const bookingId = bookingIdByCode.get(code.trim().toUpperCase());
  const booking = bookingId && bookings.get(bookingId);
  if (!booking) {
    return sendError(res, 404, 'BOOKING_NOT_FOUND', 'Booking not found');
  }

  if (booking.status === 'redeemed') {
    return sendError(res, 409, 'ALREADY_REDEEMED', 'Booking has already been redeemed');
  }

  // The code is valid up to, but not including, expiresAt.
  const now = clock.now();
  if (now >= Date.parse(booking.expiresAt)) {
    return sendError(res, 410, 'CODE_EXPIRED', 'Redemption code has expired');
  }

  booking.status = 'redeemed';
  booking.redeemedAt = new Date(now).toISOString();

  return res.json(booking);
});

app.get('/users/:id', (req, res) => {
  const user = users.get(req.params.id);
  if (!user) {
    return sendError(res, 404, 'USER_NOT_FOUND', 'User not found');
  }

  // Reverse insertion order first so bookings created in the same millisecond still come out newest first
  // (sort is stable, so ties keep this order).
  const userBookings = [...bookings.values()]
    .filter((booking) => booking.userId === user.id)
    .reverse()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  return res.json({ ...user, bookings: userBookings });
});

// Catch-all: any request that didn't match a route above (unknown path, or a known path with the wrong method).
app.use((req, res) => {
  sendError(res, 404, 'NOT_FOUND', `Cannot ${req.method} ${req.path}`);
});

// Error handler: always answer with JSON instead of Express's default HTML error page.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err.type === 'entity.parse.failed') {
    return sendError(res, 400, 'INVALID_JSON', 'Invalid JSON body');
  }

  // Other request problems raised by Express/body-parser, e.g. body too large (413) or unsupported charset (415).
  const status = err.status ?? err.statusCode;
  if (status >= 400 && status < 500) {
    return sendError(res, status, 'BAD_REQUEST', err.expose ? err.message : 'Bad request');
  }

  // Anything else is a bug: log it, but don't leak details to the client.
  console.error(err);
  return sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
}

module.exports = { app, users, venues, bookings, bookingIdByCode, seed, clock };
