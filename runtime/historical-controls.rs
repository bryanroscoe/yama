// Host-control transport shim only. The pinned rules, AI and replay reducers stay unchanged.
#[derive(Serialize, Deserialize)]
pub struct HistoricalControls {
    full_control: bool,
    stops: Option<Stops>,
    passing: Option<(PassMode, u32)>,
    hold: bool,
    tap_mana: PayMode,
}
impl Match {
    pub fn saved_controls(&self, seat: u8) -> HistoricalControls {
        let c = self.controls(seat);
        HistoricalControls { full_control: c.full_control, stops: c.stops,
            passing: c.passing.map(|p| (p.mode, p.turn)), hold: c.hold, tap_mana: c.tap_mana }
    }
    /// Reconstruct controls the old engine already recovered from its action log,
    /// without submitting another action or advancing its revision.
    pub fn restore_replayed_controls(&mut self) {
        use engine::types::phase::PhaseStopScope;
        for recorded in &self.log.actions {
            match &recorded.action {
                GameAction::SetPriorityPassingMode { mode } => {
                    self.controls.entry(recorded.actor.0).or_default().full_control =
                        *mode == PriorityPassingMode::FullControl;
                }
                GameAction::SetPhaseStops { stops } => {
                    let mut mapped = Stops::default();
                    for stop in stops {
                        let phase = format!("{:?}", stop.phase);
                        if matches!(stop.scope, PhaseStopScope::AllTurns | PhaseStopScope::OwnTurn) {
                            mapped.own.insert(phase.clone());
                        }
                        if matches!(stop.scope, PhaseStopScope::AllTurns | PhaseStopScope::OpponentsTurns) {
                            mapped.others.insert(phase);
                        }
                    }
                    self.controls.entry(recorded.actor.0).or_default().stops = (!stops.is_empty()).then_some(mapped);
                }
                _ => {}
            }
        }
    }

    /// Restore a newer transport sidecar, including the distinction between a
    /// standing Full control preference and a temporary priority hold.
    pub fn restore_game_controls(&mut self, seat: u8, c: HistoricalControls) -> anyhow::Result<()> {
        anyhow::ensure!(self.state.players.iter().any(|p| p.id.0 == seat), "unknown control owner");
        self.controls.insert(seat, Controls { full_control: c.full_control, stops: c.stops,
            passing: c.passing.map(|(mode, turn)| turns::Passing { mode, turn }), hold: c.hold, tap_mana: c.tap_mana });
        Ok(())
    }

    /// Account preferences fill only fields absent from legacy replay inputs.
    /// The worker admits this initialization once per seat, separately from
    /// explicit player changes, which still use the original setters.
    pub fn initialize_prefs(&mut self, seat: u8, stops: Option<Stops>, full_control: bool, tap_mana: PayMode) {
        let full_restored = self.log.actions.iter().any(|a|
            a.actor.0 == seat && matches!(&a.action, GameAction::SetPriorityPassingMode { .. }));
        let stops_restored = self.log.actions.iter().any(|a|
            a.actor.0 == seat && matches!(&a.action, GameAction::SetPhaseStops { .. }));
        let controls = self.controls.entry(seat).or_default();
        if !full_restored { controls.full_control = full_control; }
        if !stops_restored { controls.stops = stops; }
        controls.tap_mana = tap_mana;
        // Recovered engine modes, including SkipLowUseWindows, are authoritative.
        if !full_restored { self.sync_passing_mode(seat); }
    }
}
