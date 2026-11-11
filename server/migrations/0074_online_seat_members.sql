-- Online games now seat a person who belongs to the game's playgroup as that member, as the
-- table does (play.rs, start_game). Older online seats carry only the account, so the Group page
-- left them out of "Your rivalries". Fill the member in where it is certain: the seat's account
-- has a member row in the game's own playgroup (at most one: playgroup_members_user is unique).
-- Seats without an account, games without a playgroup and in-person games are left as they are.
UPDATE game_seats
SET member_id = (
    SELECT m.id FROM playgroup_members m JOIN games g ON g.playgroup_id = m.playgroup_id
    WHERE g.id = game_seats.game_id AND m.user_id = game_seats.user_id
)
WHERE member_id IS NULL
  AND user_id IS NOT NULL
  AND game_id IN (SELECT id FROM games WHERE mode = 'online' AND playgroup_id IS NOT NULL);
