# Composite styles and languages

Each model can have four independently published composite variants. They share one visual template and the same canvas geometry.

## Four independent variants
- Basic · Russian
- Basic · English
- Fashion · Russian
- Fashion · English

Generating or replacing one variant updates only the publication with the same model, style, and language. The other three publications remain available in the COMPOSITES topic.

## Photo bank
- Each model can have a Basic set and a Fashion set.
- Each set contains exactly seven Telegram photos in position order.
- Existing `model_telegram_photos` rows are migrated into the Basic set.
- After a seven-photo upload in MODEL BANK, Secretary asks which set to save.
- Replacing a photo set only replaces the selected style; the other style is left untouched.
- Both languages use the selected style's same seven-photo set.

## Composite creation
- `/comp` first asks for Basic or Fashion, then Russian or English.
- The user can provide names inline with `/comp` or send the list after choosing the options.
- Every model in a batch must have the selected photo set. Missing sets produce an explicit error and are never substituted with the other style.
- English transliterates the model name and translates hair/eye colors. Clothing and shoe sizes remain exactly as entered in the profile.
- Language does not change the model profile or the visual layout.

## Refresh
Scheduled and manual composite refreshes retain the style/language of every existing publication and queue each existing variant independently.

## Topic verification
Run `/topics_check` as the owner/director in the agency supergroup. It reports the configured MODEL BANK and COMPOSITES chat/topic IDs and checks that both topics are registered in the same group.
