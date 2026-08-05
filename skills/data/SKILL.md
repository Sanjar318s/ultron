---
name: data
description: Анализ и обработка данных: pandas (таблицы, CSV/Excel), numpy (численные расчёты), matplotlib (графики и диаграммы). Используй, когда пользователь просит «проанализируй данные», «построй график», «обработай CSV/Excel», «посчитай статистику», «визуализируй», «сделай дашборд», «найди закономерности/тренды/аномалии», «среднее/медиану/корреляцию», любую работу с датасетами и числами.
safe: true
---

# Дата-стек (pandas / numpy / matplotlib)

Ты анализируешь данные и строишь визуализации в песочнице. Установлены: pandas 3.x, numpy 2.x, matplotlib 3.x.

## Как работать

1. Пойми задачу: что дано (в тексте сообщения или уже в рабочей папке), что нужно получить (таблица, число, график).
2. Если данных нет — создай их скриптом (данные из запроса пользователя), либо попроси файл.
3. **Создай скрипт** через файл-хелпер. Содержимое — ОДИН аргумент после `--raw` с JSON-эскейпами (`\n` вместо переносов):

```
node "ПУТЬ/sandbox-write.mjs" "work.py" --raw "import numpy as np\nimport matplotlib\nmatplotlib.use(\"Agg\")\nimport matplotlib.pyplot as plt\nx = np.linspace(-5, 5, 200)\nplt.plot(x, x**2)\nplt.savefig(\"plot.png\", dpi=120)\nprint(\"saved plot.png\")"
```

4. **Запусти**:

```
python "work.py"
```

5. Если нужна ещё библиотека — установи: `pip install <имя>`, затем попробуй снова.
6. Если нужен результат в файле (график, отчёт, CSV) — сохрани в рабочей папке и в `result` обязательно укажи путь к файлу.

## Пример (для задачи «построить график y = x²»)

- `work.py`:

```python
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
x = np.linspace(-5, 5, 200)
plt.figure(figsize=(6, 4))
plt.plot(x, x**2, label="y = x^2")
plt.xlabel("x"); plt.ylabel("y"); plt.grid(True); plt.legend()
plt.savefig("plot.png", dpi=120)
print("saved plot.png")
```

- команда создания (всё в одном аргументе, переносы как `\n`):

```
node "<хелпер>/sandbox-write.mjs" "work.py" --raw "import numpy as np\nimport matplotlib\nmatplotlib.use(\"Agg\")\nimport matplotlib.pyplot as plt\nx = np.linspace(-5, 5, 200)\nplt.figure(figsize=(6, 4))\nplt.plot(x, x**2, label=\"y = x^2\")\nplt.xlabel(\"x\"); plt.ylabel(\"y\"); plt.grid(True); plt.legend()\nplt.savefig(\"plot.png\", dpi=120)\nprint(\"saved plot.png\")"
```

- затем `python "work.py"`, вывод `saved plot.png` и есть результат; файл `plot.png` лежит в рабочей папке — его путь укажи в `done.result`.

## Правила

- Графики обязательно сохраняй в PNG (matplotlib.use("Agg") — без показа окна).
- Кодировки: читай CSV с `encoding="utf-8"` (или `encoding="cp1251"` при ошибке).
- Кириллицу в выводах и надписях сохраняй корректно (UTF-8).
- Большие выборки не печатай целиком — выводи summary (head, describe, значения метрик).
- В финальном `{"done":true,"result":"…"}` дай итог: что посчитано/построено и путь к файлу.

## Запрещено

- Приветствия и рассказы «среда готова» — первый ответ должен быть командой.
- Возврат `done` без результата (числа, таблицы, файла графика).
- Создал скрипт — обязан затем ЗАПУСТИТЬ его (`python "work.py"`), дождаться вывода и привести вывод/путь к файлу в `done.result`. Создание файла без запуска — не результат.
- Команды вне списка: только `python`, `py`, `node`, `pip`.
- Файлы вне рабочей папки, относительный путь без `..`.
