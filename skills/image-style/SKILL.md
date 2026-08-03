---
name: image-style
description: Стилевые правила и готовые пресеты для генерации картинок через локальный ComfyUI (RealVisXL V5.0). Используй, когда пользователь просит нарисовать изображение в определённом стиле — киберпанк, акварель, фотореализм, мультфильм, логотип, постер, ретро-плакат и т.п. Знаниевый навык: скрипты не нужны, примени правила напрямую.
safe: true
---

# Стили генерации изображений (ComfyUI / RealVisXL V5.0)

Локальный генератор — RealVisXL V5.0 fp16, 28 шагов dpmpp_2m/karras, CFG ~4-6.
Ниже — проверенные пресеты. Применяй их к промпту, который строит LLM.

## Базовые правила
- Промпт пиши **по-английски** (модель обучена на английском). RU-запрос переводи.
- Формат: `<subject>, <scene>, <composition>, <lighting>, <style keyword>, <quality tags>`.
- Обязательные quality-теги: `masterpiece, best quality, highly detailed, sharp focus`.
- Негатив (если доступен): `lowres, bad anatomy, bad hands, text, watermark, blurry`.
- Соотношение сторон подбирай под сюжет: 1:1 (портрет/иконка), 16:9 (пейзаж/постер), 9:16 (вертикальный арт).
- Если пользователь дал хэштеги/теги от сантайзера (nude, breasts и т.п.) — они добавляются в конец локального промпта только для ComfyUI.

## Пресеты
| Стиль | Ключевые слова для промпта |
|---|---|
| Фотореализм | `photorealistic, 35mm, f/1.8, shallow depth of field, natural skin texture, cinematic lighting` |
| Киберпанк | `cyberpunk, neon signs, rain-soaked street, holographic ads, blade-runner atmosphere, teal and magenta palette` |
| Акварель | `watercolor painting, soft washes, paper texture, loose brush strokes, light colors` |
| Масло | `oil painting, impasto, visible brush strokes, warm palette, renaissance lighting` |
| Мультфильм | `2d cartoon, vibrant colors, clean bold outlines, pixar-like, expressive` |
| Аниме | `anime style, cel shading, detailed eyes, dynamic pose, vibrant` |
| Логотип | `minimalist logo, flat vector, clean lines, single accent color, transparent background feel, centered` |
| Постер | `movie poster, dramatic composition, strong contrast, title-space at top, cinematic` |
| Ретро-плакат | `vintage 1950s poster, retro colors, grain texture, classic typography space` |
| Космос | `deep space, nebula, stars, sci-fi, ultra detailed, volumetric lighting` |
| Пиксель-арт | `pixel art, 16-bit, retro game style, limited palette, crisp pixels` |
| 3D-рендер | `3d render, octane, subsurface scattering, studio lighting, high poly` |

## Формат ответа
Верни `{"done":true,"result":"<готовый английский промпт со стилем>"}`. Один промпт — одна строка. Не вызывай скрипты.
