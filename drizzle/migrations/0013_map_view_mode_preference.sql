ALTER TABLE "user_profiles"
ADD COLUMN "map_view_mode" text DEFAULT 'globe' NOT NULL;

ALTER TABLE "user_profiles"
ADD CONSTRAINT "user_profiles_map_view_mode_valid"
CHECK ("map_view_mode" IN ('globe', 'flat'));
