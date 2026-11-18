# Composite styles and languages

The composite card keeps one shared 2400x1500 horizontal layout. Basic and Fashion are photo banks, not separate templates.

## Photo bank
- Each model can have a Basic set and a Fashion set.
- Each set contains exactly seven Telegram photos in position order.
- Existing `model_telegram_photos` rows are migrated into the Basic set.
- After a seven-photo upload in MODEL BANK, Secretary asks which set to save.
- Replacing a set only replaces the selected style; the other style is left untouched.

## Composite creation
- `/comp` first asks for Basic or Fashion, then Russian or English.
- The user can provide names inline with `/comp` or send the list after choosing the options.
- Every model in a batch must have the selected photo set. Missing sets produce an explicit error and are never substituted with the other style.
- English changes the measurement labels and unit text only. The card geometry, photo positions, and visual template stay identical.

## Topic verification
Run `/topics_check` as the owner/director in the agency supergroup. It reports the configured MODEL BANK and COMPOSITES chat/topic IDs and checks that both topics are registered in the same group.
