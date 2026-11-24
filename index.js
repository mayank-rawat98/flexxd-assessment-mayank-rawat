const express = require('express');

const app = express();
app.use(express.json());

// In-memory store
const users = new Map(); // userId -> { id, name, credits }
const venues = new Map(); // venueId -> { id, name, price, dailyCapacity }
const bookings = new Map(); // bookingId -> booking
const bookingIdByCode = new Map(); // redemptionCode -> bookingId

// Clears everything and loads the seed data. Call in tests (e.g. beforeEach) for a clean slate.
function seed() {
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

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
}

module.exports = { app, users, venues, bookings, bookingIdByCode, seed };
