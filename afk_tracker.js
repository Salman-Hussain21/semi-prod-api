const mysql = require('mysql2/promise');

class AFKTracker {
    constructor(dbConfig) {
        this.pool = mysql.createPool(dbConfig);
        this.sessions = new Map(); // Key: steam_id (NAME_PlayerName), Value: Session Object
        this.BUFFER_SECONDS = 90;
        this.lastPollTime = Date.now();
    }

    /**
     * Process new poll data
     * @param {Array} players - List of player objects from GameDig
     */
    processPoll(players) {
        const now = Date.now();
        const timeDeltaSeconds = (now - this.lastPollTime) / 1000;
        this.lastPollTime = now;

        // Current set of IDs to detect disconnects
        const currentIds = new Set();

        players.forEach(p => {
            const name = p.name;
            if (!name) return; // Skip invalid names

            // ID Generation Scheme (Matching PHP: "NAME_" + name)
            const steamId = `NAME_${name.trim()}`;
            currentIds.add(steamId);

            // Get or Init Session
            if (!this.sessions.has(steamId)) {
                this.sessions.set(steamId, {
                    name: name,
                    last_score: p.score || 0,
                    last_team: p.raw ? p.raw.team : -1,
                    buffer_accumulated: 0,
                    session_active_seconds: 0,
                    session_afk_seconds: 0,
                    is_afk: false,
                    last_activity_ts: now,
                    unsaved_active: 0,
                    unsaved_afk: 0
                });
                // New joiner is considered active initially for the first slice
                this._markActive(this.sessions.get(steamId), timeDeltaSeconds, p);
                return;
            }

            const session = this.sessions.get(steamId);

            // --- Heuristics ---
            // 1. Score Changed?
            const scoreChanged = p.score !== session.last_score;
            // 2. Team Changed?
            const currentTeam = p.raw ? p.raw.team : -1;
            const teamChanged = currentTeam !== session.last_team;
            // 3. Is Spectator? (CS1.6: usually 0=Unassigned, 1=T, 2=CT, 3=Spec)
            // We treat Spectator as ALWAYS AFK processing unless they just joined/changed team
            // But if they are just sitting in Spec, they are AFK.
            const isSpectator = (currentTeam === 3 || currentTeam === 0); // Assuming 0/3 are non-playing

            let isActiveEvent = scoreChanged || teamChanged;

            // Update stored state
            session.last_score = p.score;
            session.last_team = currentTeam;

            if (isActiveEvent) {
                // Activity Detected -> Reset AFK status
                this._markActive(session, timeDeltaSeconds, p);
            } else {
                // No specific activity event
                if (isSpectator) {
                    // Spectators accumulate AFK immediately after buffer?
                    // Or just treat as inactive time.
                    this._processInactive(session, timeDeltaSeconds);
                } else {
                    // In-game but score didn't change
                    this._processInactive(session, timeDeltaSeconds);
                }
            }
        });

        // Clean up disconnected players
        for (const [sid, session] of this.sessions) {
            if (!currentIds.has(sid)) {
                // Player disconnected
                // We could flush final stats here if we wanted to be precise immediately
                // For now, we leave them in map until next flush or simple timeout cleanup?
                // Better to keep them in map but maybe mark as disconnected to remove later?
                // Simplest: Just delete from map. We flush periodically anyway.
                // WAIT: If we delete, we lose unsaved stats. We should flush this player NOW.
                // However, flush is async.
                // We'll intentionally leave them until 'flushToDB' runs, or handle partial flush?
                // Let's rely on global flush for simplicity, but mark them as "dead" to prevent memory leaks?
                // Actually, if we delete them, we MUST save 'unsaved_active'/'unsaved_afk' first.
                // We'll keep them in memory but handle cleanup in flushToDB.
                session.disconnected = true;
            } else {
                session.disconnected = false; // They are back/present
            }
        }
    }

    _markActive(session, deltaSeconds, p) {
        // Reset Buffer
        session.buffer_accumulated = 0;
        session.is_afk = false;
        session.last_activity_ts = Date.now();

        // Add to active time
        session.session_active_seconds += deltaSeconds;
        session.unsaved_active += deltaSeconds;
    }

    _processInactive(session, deltaSeconds) {
        // Add to buffer
        session.buffer_accumulated += deltaSeconds;

        if (session.buffer_accumulated > this.BUFFER_SECONDS) {
            // Buffer exceeded -> Count as AFK
            // If we just crossed the threshold, we DO NOT retroactively add buffer time as AFK?
            // "If inactivity duration exceeds buffer, only the excess time is counted as AFK."
            // Yes.
            session.is_afk = true;
            session.session_afk_seconds += deltaSeconds;
            session.unsaved_afk += deltaSeconds;
        } else {
            // Still in buffer -> Count as 'Active' conceptually?
            // "If activity detected, count slice time as ACTIVE."
            // "If no activity and inactivity duration exceeds buffer, count slice time as AFK."
            // What about the time IN the buffer?
            // Usually buffer time is "assumed active" until proven otherwise, or "neutral".
            // Prompt says: "If inactivity duration exceeds buffer, only the excess time is counted as AFK."
            // This implies the buffer time itself remains "Active" or ignored.
            // Let's count buffer time as Active for stats purposes, OR just don't count it as AFK.
            // "Time Slice Model... If activity detected, count... ACTIVE. If no activity ... exceeds buffer, count ... AFK."
            // It leaves a gap for "No activity AND within buffer".
            // I will count it as ACTIVE because the player hasn't been deemed AFK yet.
            // This prevents "missing minutes" in the total sum.
            session.session_active_seconds += deltaSeconds;
            session.unsaved_active += deltaSeconds;
        }
    }

    async flushToDB() {
        const connection = await this.pool.getConnection();
        try {
            const promises = [];
            const toDelete = [];

            for (const [sid, session] of this.sessions) {
                // If nothing to save, skip
                if (session.unsaved_active < 1 && session.unsaved_afk < 1 && !session.disconnected) continue;

                const activeMin = session.unsaved_active / 60;
                const afkMin = session.unsaved_afk / 60;

                // Reset accumulators
                session.unsaved_active = 0;
                session.unsaved_afk = 0;

                // Update DB
                // Math: afk_percentage = total_afk / (total_active + total_afk) * 100
                // We update the columns, then recalculate percentage in SQL or just update sums.
                // MySQL doesn't do "UPDATE ... SET col = col + val, perc = (col_afk / (col_active+col_afk))" easily in one go if referencing updated values.
                // We'll update the sums first.
                // Actually, use a stored procedure or complex query?
                // Simple query:
                // UPDATE players SET
                //  total_active_minutes = total_active_minutes + ?,
                //  total_afk_minutes = total_afk_minutes + ?,
                //  afk_percentage = (total_afk_minutes / NULLIF((total_active_minutes + total_afk_minutes), 0)) * 100
                // WHERE steam_id = ?

                // NOTE: We rely on the fact that UPDATE uses the value *snapshot* for calculation unless we repeat expression.
                // Actually standard SQL: "SET a = a + 1, b = a" -> b uses OLD a in MySQL (usually), but it's tricky.
                // Better to just update the Sums. Percentage can be calculated on read (SELECT) or update it separately.
                // I will update Sums AND Percentage in one query using the expressions.
                // total_active_minutes + ? is the NEW value.
                // So I need to write the expression for percentage using (total_afk + new_afk) / (total_active + new_active + total_afk + new_afk).

                const q = `
                    UPDATE players
                    SET
                        total_active_minutes = total_active_minutes + ?,
                        total_afk_minutes = total_afk_minutes + ?,
                        afk_percentage = ((total_afk_minutes + ?) / NULLIF((total_active_minutes + ? + total_afk_minutes + ?), 0)) * 100
                    WHERE steam_id = ?
                `;

                promises.push(connection.execute(q, [
                    activeMin,
                    afkMin,
                    afkMin, // for numerator
                    activeMin, // for denom
                    afkMin, // for denom
                    sid
                ]));

                if (session.disconnected) {
                    toDelete.push(sid);
                }
            }

            await Promise.all(promises);

            // Cleanup disconnected sessions
            toDelete.forEach(sid => this.sessions.delete(sid));

            console.log(`[AFKTracker] Flushed stats for ${promises.length} players.`);
        } catch (e) {
            console.error("[AFKTracker] DB Flush Error:", e);
        } finally {
            connection.release();
        }
    }

    getLiveStatus() {
        // Return array of player status
        return Array.from(this.sessions.values()).map(s => ({
            name: s.name,
            active_minutes: Math.round(s.session_active_seconds / 60),
            afk_minutes: Math.round(s.session_afk_seconds / 60),
            last_activity_time: new Date(s.last_activity_ts).toISOString(),
            status: s.is_afk ? 'INACTIVE_ESTIMATED' : 'ACTIVE',
            buffer_seconds: Math.round(s.buffer_accumulated)
        }));
    }
}

module.exports = AFKTracker;
