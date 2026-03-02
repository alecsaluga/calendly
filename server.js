const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

// OAuth credentials
const CLIENT_ID = 'VWuczQl6BV6RF43ATEqCxEhsZKSlwCmfp2KMfVU7Hts';
const CLIENT_SECRET = 'KKJWbgDvNnjyYfSQbXLckt3o-I-t8oUK30f42fuuIVk';
const REDIRECT_URI = 'http://localhost:3000/callback';

// File path for persistent storage
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

// Load accounts from file
function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      const data = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading accounts:', error.message);
  }
  return {};
}

// Save accounts to file
function saveAccounts() {
  try {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(connectedAccounts, null, 2));
  } catch (error) {
    console.error('Error saving accounts:', error.message);
  }
}

// Load connected accounts from file (persists across restarts)
const connectedAccounts = loadAccounts();

// Refresh an expired access token using the refresh token
async function refreshAccessToken(email) {
  const account = connectedAccounts[email];
  if (!account || !account.refreshToken) {
    throw new Error('No refresh token available');
  }

  console.log(`Refreshing token for ${email}...`);

  const tokenResponse = await axios.post(
    'https://auth.calendly.com/oauth/token',
    {
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: account.refreshToken
    },
    {
      headers: { 'Content-Type': 'application/json' }
    }
  );

  const { access_token, refresh_token } = tokenResponse.data;

  // Update stored tokens
  connectedAccounts[email].accessToken = access_token;
  connectedAccounts[email].refreshToken = refresh_token;
  saveAccounts();

  console.log(`Token refreshed successfully for ${email}`);
  return access_token;
}

// Make an authenticated API request with automatic token refresh
async function makeAuthenticatedRequest(email, requestFn) {
  const account = connectedAccounts[email];
  if (!account) {
    throw new Error('Account not found');
  }

  try {
    // Try the request with current token
    return await requestFn(account.accessToken);
  } catch (error) {
    // If unauthorized (token expired), refresh and retry
    if (error.response?.status === 401 || error.response?.data?.message?.includes('invalid')) {
      try {
        const newToken = await refreshAccessToken(email);
        return await requestFn(newToken);
      } catch (refreshError) {
        console.error(`Failed to refresh token for ${email}:`, refreshError.message);
        throw refreshError;
      }
    }
    throw error;
  }
}

// Generate consistent colors for calendar pills
const calendarColors = ['#4285f4', '#ea4335', '#fbbc04', '#34a853', '#ff6d01', '#46bdc6', '#7baaf7', '#f07b72'];
function getCalendarColor(index) {
  return calendarColors[index % calendarColors.length];
}

// Home page - shows all events and connect button
app.get('/', async (req, res) => {
  const selectedDate = req.query.date || new Date().toISOString().split('T')[0];

  // Create date range that accounts for timezone differences
  // Expand by 12 hours on each side to cover all timezones
  const startOfDay = new Date(`${selectedDate}T00:00:00`);
  const endOfDay = new Date(`${selectedDate}T23:59:59`);
  startOfDay.setHours(startOfDay.getHours() - 12);
  endOfDay.setHours(endOfDay.getHours() + 12);

  const minStartTime = startOfDay.toISOString();
  const maxStartTime = endOfDay.toISOString();

  const connectedEmails = Object.keys(connectedAccounts);
  const allEvents = [];

  // Fetch events from all connected accounts (with automatic token refresh)
  for (const [email, account] of Object.entries(connectedAccounts)) {
    try {
      const eventsResponse = await makeAuthenticatedRequest(email, (token) =>
        axios.get(
          `https://api.calendly.com/scheduled_events?user=${encodeURIComponent(account.userUri)}&min_start_time=${encodeURIComponent(minStartTime)}&max_start_time=${encodeURIComponent(maxStartTime)}&count=50`,
          { headers: { Authorization: `Bearer ${token}` } }
        )
      );
      const events = eventsResponse.data.collection || [];
      // Filter events to only those on the selected date (in local time)
      events.forEach(event => {
        const eventDate = new Date(event.start_time).toLocaleDateString('en-CA'); // YYYY-MM-DD format
        if (eventDate === selectedDate) {
          allEvents.push({ ...event, calendarEmail: email });
        }
      });
    } catch (error) {
      console.error(`Error fetching events for ${email}:`, error.message);
    }
  }

  // Sort events by start time
  allEvents.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));

  // Group events by calendar
  const eventsByCalendar = {};
  connectedEmails.forEach(email => {
    eventsByCalendar[email] = allEvents.filter(e => e.calendarEmail === email);
  });

  // Build calendar pills HTML
  const calendarPillsHtml = connectedEmails.map((email, index) => `
    <label class="filter-pill active" data-email="${email}">
      <input type="checkbox" class="calendar-checkbox" data-email="${email}" checked onchange="filterCalendars()">
      <span class="pill-dot" style="background: ${getCalendarColor(index)}"></span>
      <span class="pill-text">${email.split('@')[0]}</span>
      <span class="pill-remove" onclick="togglePill(event, '${email}')">×</span>
    </label>
  `).join('');

  // Build events grouped by calendar
  const eventsGroupedHtml = connectedEmails.map((email, index) => {
    const calendarEvents = eventsByCalendar[email];
    const color = getCalendarColor(index);

    const eventsRows = calendarEvents.length > 0 ? calendarEvents.map(event => {
      const startTime = new Date(event.start_time);
      const endTime = new Date(event.end_time);
      const duration = Math.round((endTime - startTime) / 60000);
      return `
        <tr class="event-row">
          <td class="time-col">${startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
          <td class="event-col">${event.name}</td>
          <td class="duration-col">${duration} min</td>
        </tr>
      `;
    }).join('') : `
      <tr class="event-row no-events-row">
        <td colspan="3" class="no-events-cell">Nothing scheduled</td>
      </tr>
    `;

    return `
      <div class="calendar-section" data-email="${email}">
        <div class="calendar-header">
          <span class="calendar-dot" style="background: ${color}"></span>
          <span class="calendar-name">${email.split('@')[0]}</span>
          <span class="event-count">${calendarEvents.length} event${calendarEvents.length !== 1 ? 's' : ''}</span>
        </div>
        <table class="events-table">
          <thead>
            <tr>
              <th style="width: 100px">Time</th>
              <th>Event</th>
              <th style="width: 80px; text-align: right">Duration</th>
            </tr>
          </thead>
          <tbody>
            ${eventsRows}
          </tbody>
        </table>
      </div>
    `;
  }).join('');

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Calendly Dashboard</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
          background: #f5f7fa;
          color: #1a1a2e;
          line-height: 1.6;
        }
        .container { max-width: 1100px; margin: 0 auto; padding: 30px 20px; }

        /* Header */
        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 24px;
          flex-wrap: wrap;
          gap: 16px;
        }
        .header h1 {
          font-size: 28px;
          font-weight: 600;
          color: #1a1a2e;
        }
        .btn {
          padding: 10px 20px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          border: none;
          border-radius: 8px;
          transition: all 0.2s;
          text-decoration: none;
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }
        .btn-primary { background: #4f46e5; color: white; }
        .btn-primary:hover { background: #4338ca; transform: translateY(-1px); }
        .btn-secondary { background: white; color: #4f46e5; border: 1px solid #e2e8f0; }
        .btn-secondary:hover { background: #f8fafc; }

        /* Cards */
        .card {
          background: white;
          border-radius: 12px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.1);
          padding: 24px;
          margin-bottom: 20px;
        }
        .card-title {
          font-size: 16px;
          font-weight: 600;
          color: #64748b;
          margin-bottom: 16px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        /* Filters Section */
        .filters-row {
          display: flex;
          align-items: center;
          gap: 16px;
          flex-wrap: wrap;
        }
        .filter-group {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .filter-label {
          font-size: 14px;
          color: #64748b;
          font-weight: 500;
        }
        .date-input {
          padding: 10px 14px;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          font-size: 14px;
          color: #1a1a2e;
          background: white;
          cursor: pointer;
        }
        .date-input:focus { outline: none; border-color: #4f46e5; }

        /* Calendar Pills */
        .calendar-pills {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          align-items: center;
        }
        .filter-pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          background: #f1f5f9;
          border-radius: 20px;
          font-size: 13px;
          cursor: pointer;
          transition: all 0.2s;
          border: 1px solid transparent;
        }
        .filter-pill:hover { background: #e2e8f0; }
        .filter-pill.active { background: #eef2ff; border-color: #c7d2fe; }
        .filter-pill.inactive { opacity: 0.5; }
        .filter-pill input { display: none; }
        .pill-dot { width: 8px; height: 8px; border-radius: 50%; }
        .pill-text { color: #334155; font-weight: 500; }
        .pill-remove {
          color: #94a3b8;
          font-size: 16px;
          line-height: 1;
          margin-left: 2px;
        }
        .pill-remove:hover { color: #64748b; }
        .all-pill {
          background: #1a1a2e;
          color: white;
        }
        .all-pill .pill-text { color: white; }
        .all-pill:hover { background: #2d2d44; }

        /* Availability Checker */
        .availability-section {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 24px;
        }
        .availability-form {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .form-row {
          display: flex;
          gap: 12px;
        }
        .form-group {
          flex: 1;
        }
        .form-group label {
          display: block;
          font-size: 13px;
          font-weight: 500;
          color: #64748b;
          margin-bottom: 6px;
        }
        .form-group input, .form-group select {
          width: 100%;
          padding: 10px 12px;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          font-size: 14px;
          color: #1a1a2e;
        }
        .form-group input:focus, .form-group select:focus {
          outline: none;
          border-color: #4f46e5;
        }
        .btn-check {
          padding: 12px 24px;
          background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
          color: white;
          border: none;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
        }
        .btn-check:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(79, 70, 229, 0.4); }
        .btn-check:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }

        /* Availability Results */
        .availability-results {
          background: #f8fafc;
          border-radius: 8px;
          padding: 16px;
          min-height: 150px;
        }
        .results-title {
          font-size: 14px;
          font-weight: 600;
          color: #334155;
          margin-bottom: 12px;
        }
        .result-item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px;
          background: white;
          border-radius: 6px;
          margin-bottom: 8px;
        }
        .result-icon {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 14px;
        }
        .result-icon.available { background: #dcfce7; color: #16a34a; }
        .result-icon.busy { background: #fee2e2; color: #dc2626; }
        .result-email { font-weight: 500; color: #1a1a2e; flex: 1; }
        .result-conflict { font-size: 12px; color: #64748b; }
        .result-placeholder {
          color: #94a3b8;
          font-size: 14px;
          text-align: center;
          padding: 40px;
        }

        /* Calendar Sections */
        .calendar-section {
          margin-bottom: 24px;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          overflow: hidden;
        }
        .calendar-section.hidden { display: none; }
        .calendar-header {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 14px 16px;
          background: #f8fafc;
          border-bottom: 1px solid #e2e8f0;
        }
        .calendar-name {
          font-weight: 600;
          color: #1a1a2e;
          flex: 1;
        }
        .event-count {
          font-size: 13px;
          color: #64748b;
          background: #e2e8f0;
          padding: 2px 10px;
          border-radius: 12px;
        }

        /* Events Table */
        .events-table {
          width: 100%;
          border-collapse: collapse;
        }
        .events-table th {
          text-align: left;
          padding: 10px 16px;
          font-size: 11px;
          font-weight: 600;
          color: #94a3b8;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          background: #fafbfc;
        }
        .events-table td {
          padding: 12px 16px;
          border-bottom: 1px solid #f1f5f9;
          font-size: 14px;
        }
        .events-table tbody tr:last-child td { border-bottom: none; }
        .event-row { transition: background 0.15s; }
        .event-row:hover:not(.no-events-row) { background: #f8fafc; }
        .time-col {
          font-weight: 600;
          color: #1a1a2e;
          width: 100px;
        }
        .calendar-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
        .event-col { color: #1a1a2e; }
        .duration-col { color: #64748b; width: 80px; text-align: right; }
        .no-events-cell {
          color: #94a3b8;
          font-style: italic;
          padding: 20px 16px !important;
        }
        .no-calendars {
          text-align: center;
          color: #94a3b8;
          padding: 40px;
        }

        /* Empty State */
        .empty-state {
          text-align: center;
          padding: 60px 20px;
        }
        .empty-state h2 {
          font-size: 20px;
          color: #1a1a2e;
          margin-bottom: 8px;
        }
        .empty-state p {
          color: #64748b;
          margin-bottom: 24px;
        }

        /* Responsive */
        @media (max-width: 768px) {
          .availability-section { grid-template-columns: 1fr; }
          .form-row { flex-direction: column; }
          .filters-row { flex-direction: column; align-items: flex-start; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Calendly Dashboard</h1>
          <a href="/auth" class="btn btn-primary">
            <span>+</span> Connect Account
          </a>
        </div>

        ${connectedEmails.length > 0 ? `
          <!-- Filters Card -->
          <div class="card">
            <div class="filters-row">
              <div class="filter-group">
                <span class="filter-label">Date</span>
                <input type="date" class="date-input" id="date-picker" value="${selectedDate}" onchange="changeDate(this.value)">
              </div>
              <div class="filter-group">
                <span class="filter-label">Calendars</span>
                <div class="calendar-pills">
                  <label class="filter-pill all-pill">
                    <input type="checkbox" id="all-checkbox" checked onchange="toggleAll(this)">
                    <span class="pill-text">All</span>
                  </label>
                  ${calendarPillsHtml}
                </div>
              </div>
            </div>
          </div>

          <!-- Availability Checker Card -->
          <div class="card">
            <div class="card-title">Check Availability</div>
            <div class="availability-section">
              <div class="availability-form">
                <div class="form-row">
                  <div class="form-group">
                    <label>Date</label>
                    <input type="date" id="avail-date" value="${selectedDate}">
                  </div>
                  <div class="form-group">
                    <label>Time</label>
                    <input type="time" id="avail-time" value="14:00">
                  </div>
                </div>
                <div class="form-row">
                  <div class="form-group">
                    <label>Duration</label>
                    <select id="avail-duration">
                      <option value="15">15 minutes</option>
                      <option value="30" selected>30 minutes</option>
                      <option value="45">45 minutes</option>
                      <option value="60">1 hour</option>
                      <option value="90">1.5 hours</option>
                      <option value="120">2 hours</option>
                    </select>
                  </div>
                </div>
                <button class="btn-check" onclick="checkAvailability()" id="check-btn">
                  Check Availability
                </button>
              </div>
              <div class="availability-results" id="availability-results">
                <div class="result-placeholder">
                  Select a date, time, and duration to check availability across all calendars
                </div>
              </div>
            </div>
          </div>

          <!-- Events Card -->
          <div class="card">
            <div class="card-title">Scheduled Events — ${new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
            <div id="events-container">
              ${connectedEmails.length > 0 ? eventsGroupedHtml : '<div class="no-calendars">No calendars connected</div>'}
            </div>
          </div>
        ` : `
          <div class="card">
            <div class="empty-state">
              <h2>No calendars connected</h2>
              <p>Connect your Calendly accounts to view and manage events across all calendars.</p>
              <a href="/auth" class="btn btn-primary">
                <span>+</span> Connect Your First Account
              </a>
            </div>
          </div>
        `}
      </div>

      <script>
        function changeDate(date) {
          window.location.href = '/?date=' + date;
        }

        function toggleAll(checkbox) {
          const pills = document.querySelectorAll('.filter-pill:not(.all-pill)');
          pills.forEach(pill => {
            const cb = pill.querySelector('.calendar-checkbox');
            cb.checked = checkbox.checked;
            pill.classList.toggle('active', checkbox.checked);
            pill.classList.toggle('inactive', !checkbox.checked);
          });
          filterCalendars();
        }

        function togglePill(event, email) {
          event.preventDefault();
          event.stopPropagation();
          const pill = document.querySelector('.filter-pill[data-email="' + email + '"]');
          const cb = pill.querySelector('.calendar-checkbox');
          cb.checked = !cb.checked;
          filterCalendars();
        }

        function filterCalendars() {
          const checkboxes = document.querySelectorAll('.calendar-checkbox');
          const allCheckbox = document.getElementById('all-checkbox');

          checkboxes.forEach(cb => {
            const email = cb.dataset.email;
            const pill = document.querySelector('.filter-pill[data-email="' + email + '"]');
            pill.classList.toggle('active', cb.checked);
            pill.classList.toggle('inactive', !cb.checked);

            // Toggle calendar section visibility
            const section = document.querySelector('.calendar-section[data-email="' + email + '"]');
            if (section) {
              section.classList.toggle('hidden', !cb.checked);
            }
          });

          const allChecked = Array.from(checkboxes).every(cb => cb.checked);
          const someChecked = Array.from(checkboxes).some(cb => cb.checked);
          allCheckbox.checked = allChecked;
          allCheckbox.indeterminate = someChecked && !allChecked;
        }

        async function checkAvailability() {
          const date = document.getElementById('avail-date').value;
          const time = document.getElementById('avail-time').value;
          const duration = document.getElementById('avail-duration').value;
          const btn = document.getElementById('check-btn');
          const resultsDiv = document.getElementById('availability-results');

          btn.disabled = true;
          btn.textContent = 'Checking...';
          resultsDiv.innerHTML = '<div class="result-placeholder">Checking availability...</div>';

          try {
            const response = await fetch('/api/check-availability?date=' + date + '&time=' + time + '&duration=' + duration);
            const data = await response.json();

            let html = '<div class="results-title">Availability at ' + time + ' for ' + duration + ' min</div>';

            data.results.forEach(result => {
              const iconClass = result.available ? 'available' : 'busy';
              const icon = result.available ? '✓' : '✕';
              const conflict = result.conflict ? '<div class="result-conflict">Conflicts with: ' + result.conflict + '</div>' : '';

              html += '<div class="result-item">' +
                '<div class="result-icon ' + iconClass + '">' + icon + '</div>' +
                '<div class="result-email">' + result.email.split('@')[0] + conflict + '</div>' +
                '<span style="color: ' + (result.available ? '#16a34a' : '#dc2626') + '; font-weight: 500;">' +
                (result.available ? 'Available' : 'Busy') + '</span>' +
              '</div>';
            });

            resultsDiv.innerHTML = html;
          } catch (error) {
            resultsDiv.innerHTML = '<div class="result-placeholder" style="color: #dc2626;">Error checking availability</div>';
          }

          btn.disabled = false;
          btn.textContent = 'Check Availability';
        }
      </script>
    </body>
    </html>
  `);
});

// API endpoint to check availability across all calendars
app.get('/api/check-availability', async (req, res) => {
  const { date, time, duration } = req.query;

  if (!date || !time || !duration) {
    return res.status(400).json({ error: 'Missing date, time, or duration parameter' });
  }

  const requestedStart = new Date(`${date}T${time}:00`);
  const requestedEnd = new Date(requestedStart.getTime() + parseInt(duration) * 60000);

  // Expand range to account for timezone differences
  const startOfDay = new Date(`${date}T00:00:00`);
  const endOfDay = new Date(`${date}T23:59:59`);
  startOfDay.setHours(startOfDay.getHours() - 12);
  endOfDay.setHours(endOfDay.getHours() + 12);

  const minStartTime = startOfDay.toISOString();
  const maxStartTime = endOfDay.toISOString();

  const results = [];

  for (const [email, account] of Object.entries(connectedAccounts)) {
    try {
      const eventsResponse = await makeAuthenticatedRequest(email, (token) =>
        axios.get(
          `https://api.calendly.com/scheduled_events?user=${encodeURIComponent(account.userUri)}&min_start_time=${encodeURIComponent(minStartTime)}&max_start_time=${encodeURIComponent(maxStartTime)}&count=50`,
          { headers: { Authorization: `Bearer ${token}` } }
        )
      );

      const events = eventsResponse.data.collection || [];
      let conflictingEvent = null;

      // Check for overlapping events
      for (const event of events) {
        const eventStart = new Date(event.start_time);
        const eventEnd = new Date(event.end_time);

        // Check if requested time overlaps with this event
        if (requestedStart < eventEnd && requestedEnd > eventStart) {
          conflictingEvent = event;
          break;
        }
      }

      results.push({
        email,
        available: !conflictingEvent,
        conflict: conflictingEvent ? conflictingEvent.name : null
      });
    } catch (error) {
      results.push({
        email,
        available: false,
        conflict: 'Error checking calendar'
      });
    }
  }

  res.json({ results });
});

// Redirect to Calendly OAuth authorization
app.get('/auth', (req, res) => {
  const authUrl = `https://auth.calendly.com/oauth/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  res.redirect(authUrl);
});

// OAuth callback - exchange code for token
app.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.send(`<h1>Error</h1><p>${error}</p><a href="/">Go back</a>`);
  }

  if (!code) {
    return res.send('<h1>Error</h1><p>No authorization code received</p><a href="/">Go back</a>');
  }

  try {
    // Exchange authorization code for access token
    const tokenResponse = await axios.post(
      'https://auth.calendly.com/oauth/token',
      {
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        code: code
      },
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );

    const { access_token, refresh_token } = tokenResponse.data;

    // Get user info
    const userResponse = await axios.get('https://api.calendly.com/users/me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const user = userResponse.data.resource;
    const email = user.email;
    const userUri = user.uri;

    // Store the account info
    connectedAccounts[email] = {
      accessToken: access_token,
      refreshToken: refresh_token,
      userUri: userUri,
      name: user.name
    };

    // Save to file for persistence
    saveAccounts();

    console.log(`Connected account: ${email}`);

    res.redirect('/');
  } catch (error) {
    console.error('OAuth error:', error.response?.data || error.message);
    res.send(`
      <h1>Error</h1>
      <p>Failed to connect account: ${error.response?.data?.error_description || error.message}</p>
      <a href="/">Go back</a>
    `);
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log('Visit the URL above to connect Calendly accounts');
});
