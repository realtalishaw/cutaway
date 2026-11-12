Feature: Record edit and package a video for YouTube

  @SC-001 @US-001
  Scenario: A saved project reopens
    Given a project contains sources, manual cuts and a selected thumbnail
    When the creator saves, closes and reopens it
    Then the same media, edit revision, selected packaging and playhead are restored

  @SC-002 @US-002
  Scenario: Camera permission is denied
    Given screen capture is permitted and camera permission is denied
    When the creator chooses screen-only recording
    Then screen recording remains available
    And the unavailable camera explains its permission recovery path

  @SC-003 @US-003
  Scenario: Capture independently editable media
    Given a qualified screen, camera A, microphone and system-audio setup passes preflight
    When the creator records, pauses, resumes and stops
    Then the project contains independent enabled tracks
    And the paused interval is absent from the intended captured timeline

  @SC-004 @US-004
  Scenario: Capture two live cameras
    Given two distinct qualified camera devices and the selected format pass preflight
    When the creator records a take with cameras A and B
    Then both independent camera tracks can be previewed and switched in sync
    And assigning the same device twice is prevented

  @SC-005 @US-005
  Scenario: A camera disconnects mid-take
    Given screen, cameras A/B and a master microphone are recording
    When camera B disconnects
    Then the working sources continue or stop safely with preserved media
    And the missing camera B interval is marked
    And reopening recovers the usable segments

  @SC-006 @US-006
  Scenario: Import validates roles and limitations
    Given the creator has a supported camera MOV, a flattened screen MP4 and a corrupt file
    When the creator imports the files and assigns roles
    Then supported sources are available for editing
    And the corrupt file has an actionable error
    And the flattened import is not offered recovered original cursor metadata

  @SC-007 @US-007
  Scenario: Independent footage needs manual calibration
    Given camera B lacks a common audio or timing reference
    When the creator reviews sync and calibrates start and end points
    Then the app does not claim automatic synchronization
    And the creator can preview calibrated alignment and coverage across the take

  @SC-008 @US-008
  Scenario: One voice survives angle changes
    Given camera scratch audio overlaps the selected master voice
    When the creator confirms master audio and previews an angle switch
    Then the master voice continues once
    And camera scratch audio remains muted unless explicitly enabled
    And voice cleanup can be bypassed for comparison

  @SC-009 @US-009
  Scenario: Start editing with defaults
    Given a valid project has aligned sources and no written prompt
    When the creator chooses Create first cut
    Then the default audience, pacing and duration policy are visible
    And analysis starts without requiring free-text instructions

  @SC-010 @US-010
  Scenario: Receive an assembled edit
    Given a valid camera/screen project has completed analysis
    When the creator opens its first cut
    Then a playable edited candidate is present
    And the review summary links consequential decisions to source and output ranges

  @SC-011 @US-011
  Scenario: Keep a meaningful wait and a negation
    Given a demonstration includes a necessary loading wait and the phrase do not delete this file
    When the creator requests balanced cleanup
    Then the meaning of the phrase is preserved
    And the result of the loading step remains understandable
    And uncertain retakes can be reviewed before deletion

  @SC-012 @US-012
  Scenario: Respect source coverage during view selection
    Given camera B starts late and ends early relative to the screen recording
    When the creator requests automatic shot selection
    Then camera B appears only inside its calibrated usable range
    And critical demonstrated steps remain visible on the screen or a combined layout

  @SC-013 @US-013
  Scenario: Remove an unwanted zoom
    Given a candidate edit contains zooms, camera transitions and callouts
    When the creator removes one zoom and adjusts a callout
    Then only the selected visual operations change
    And the updated preview and export use the same decisions

  @SC-014 @US-014
  Scenario: No useful B-roll exists
    Given a creator supplied no relevant supporting clips for a section
    When the creator generates an edit with B-roll allowed
    Then the section retains a suitable available shot or accurate graphic
    And the summary does not claim nonexistent B-roll
    And supplied relevant assets elsewhere retain provenance and narration

  @SC-015 @US-015
  Scenario: Fix transcript text without making a cut
    Given a transcript contains a misspelled product name
    When the creator corrects the spelling using text correction
    Then caption text changes without removing footage
    And a separate cut-text action can remove a selected source interval and be undone

  @SC-016 @US-016
  Scenario: Regenerate only the selected section
    Given a project has a locked explanation and unrelated manual angle decisions
    When the creator asks for less movement in another selected section
    Then the locked explanation and unrelated manual decisions remain unchanged
    And a comparison shows only the intended local revision
    And undo restores the previous section

  @SC-017 @US-017
  Scenario: Subtitles follow speed changes
    Given a transcribed section has been trimmed and sped up
    When the creator exports captions
    Then subtitle intervals match the edited output duration and spoken words
    And all intervals are valid and ordered

  @SC-018 @US-018
  Scenario: A mask survives framing
    Given a time-bounded mask covers private information
    When the creator changes a zoom and camera layout and exports
    Then the masked target remains covered in the affected output frames
    And the mask does not disappear because of the layout change

  @SC-019 @US-019
  Scenario: Decline remote analysis
    Given a requested AI function would send audio or frames to a named provider
    When the creator declines the disclosed remote processing
    Then no project data is sent for that request
    And local recording, manual editing and saved work remain available

  @SC-020 @US-020
  Scenario: Recover a failed processing stage
    Given analysis completed transcription and a remote assembly job may still exist
    When the provider connection fails and the creator retries
    Then the product reconciles the original job before starting another billable job
    And completed work and sources remain available
    And the UI reports the current stage without inventing progress

  @SC-021 @US-021
  Scenario: Choose editable packaging
    Given the current video edit is ready for packaging
    When the creator requests concepts and edits one thumbnail and title
    Then three actual thumbnail/title concepts are available
    And the creator can change text, crop, colors and layout
    And the chosen title and exported image pass the declared constraints

  @SC-022 @US-022
  Scenario: Mark packaging stale after a new cut
    Given the creator selected packaging for revision one
    When the creator removes a major section and saves revision two
    Then dependent packaging and timings are marked for review
    And refreshing them does not reset unrelated manual thumbnail choices

  @SC-023 @US-023
  Scenario: Export one finished package
    Given a reviewed edit has a selected thumbnail and title and valid sources
    When the creator exports the YouTube package
    Then video, selected image and title files are validated and listed
    And applicable captions and chapters use final output timing
    And the folder records one edit revision and no YouTube upload occurs

  @SC-024 @US-024
  Scenario: Recover an export with insufficient space
    Given the export destination lacks the required space or becomes full
    When the creator attempts export
    Then the app shows an actionable disk-space failure
    And partial files are distinguished from a complete package
    And freeing space permits safe retry without losing the project

  @SC-025 @US-025
  Scenario: Relink without deleting outside sources
    Given a project references an external camera file that has moved
    When the creator relinks that source and later moves the project to Trash
    Then the source identity is checked and the intended edits return
    And the external original remains available outside the project

  @SC-026 @US-026
  Scenario: Apply a reusable style
    Given a creator has saved a framing and caption preset
    When the creator applies it to another project
    Then the appearance updates without changing source timing or locked content

  @SC-027 @US-001 @US-004 @US-007 @US-010 @US-021 @US-023
  Scenario: Complete the recording to YouTube journey
    Given a qualified two-camera setup and an independently recorded extra clip are available
    When the creator records, aligns the added clip, generates an edit, selects packaging and exports
    Then a real edited video and selected thumbnail/title package can be opened
    And the saved project still permits restoring an AI cut

  @SC-028 @US-003 @US-005
  Scenario: Recover a crash during capture
    Given a valid source setup is recording with periodic checkpoints
    When the application terminates unexpectedly and the creator reopens it
    Then recovery offers the usable checkpointed media
    And the lost interval does not exceed the qualified checkpoint tolerance

  @SC-029 @US-020
  Scenario: Explain a slow stage
    Given analysis is running without a measurable progress update
    When 30 seconds pass without an update
    Then the stage explains continued processing and allows safe navigation or cancellation
    And a fake completion percentage is not displayed

  @SC-030 @US-006 @US-010 @US-017 @US-023
  Scenario: Edit a silent screen-only recording
    Given a supported screen video has no speech and no camera
    When the creator creates an edit and exports a package
    Then the editor can use visible actions and the supplied brief
    And no fabricated speech transcript appears
    And caption omission is explained and video/thumbnail/title still export

  @SC-031 @US-004
  Scenario: Reject duplicate or unsupported cameras
    Given a camera is already assigned to camera A
    When the creator selects the same device for B or an unsupported capture combination
    Then preflight blocks the invalid selection and explains available alternatives
    And no successful two-camera capture is claimed

  @SC-032 @US-007 @US-012
  Scenario: Keep drift within tolerance
    Given independent camera footage has measurable drift and variable frame timing
    When the creator calibrates sync and previews qualified start middle and end checkpoints
    Then audio/video alignment is within one output frame at those checkpoints
    And the original source file remains unchanged

  @SC-033 @US-023 @US-024
  Scenario: Do not complete an export with missing media
    Given a required source file is unavailable
    When the creator runs export preflight
    Then complete export is blocked with a relink action
    And a previously saved valid package is not overwritten

  @SC-034 @US-019 @US-025
  Scenario: Clear caches without losing source media
    Given a project has local original media, derived previews and an unfinished job
    When the creator requests clearing derived caches
    Then the app identifies any cache needed by the unfinished job
    And originals and manual decisions remain intact
    And any remote deletion request shows its actual supported confirmation status
