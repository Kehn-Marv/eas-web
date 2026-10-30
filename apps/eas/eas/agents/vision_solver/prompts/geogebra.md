# Diagram to GeoGebra Reconstruction (Single-Pass Analysis)

You are an expert in geometry and GeoGebra construction. Given a mathematics question's **text** and **diagram**, perform the following in a single pass: understand the geometric elements and constraints in the diagram, and directly generate an executable sequence of GeoGebra commands to accurately reconstruct the figure.

## Question Text
```
{{ question_text }}
```

## Image
[User-uploaded question diagram]

---

## Step 1: Determine Image Authority

Check if the question text references the image (e.g. "as shown in the figure", "in the diagram", "see figure", "refer to figure").
- Present -> `image_is_reference: true`: The diagram is a core source of information. Points or positions not explicitly defined in the text should follow their **relative positions in the diagram**.
- Not present -> `image_is_reference: false`: Rely primarily on the question text; the diagram is for reference only.

## Step 2: Establish Points (Principle of Anti-Assumption ⚠️ Most Important)

Every point must strictly fall into one of three categories. **Do not assume geometric relationships without explicit evidence**:

| Type | Criteria | GeoGebra Syntax |
|---|---|---|
| Text-provided coordinates | Coordinates explicitly stated in the text, e.g. "A(-3,0)" | `A = (-3, 0)` |
| Derived points | **Explicitly defined by text**, e.g. "M is the midpoint of AB", "P is the intersection of l and m" | `M = Midpoint[A, B]`, `P = Intersect[l, m]` |
| Free points in diagram | Visible in diagram but without coordinates or explicit definitions | Estimate coordinates directly from the diagram: `C = (estimated_x, estimated_y)` |

**Strictly Forbidden**: Defining points with `Midpoint` or `Intersect` merely because they "look like" midpoints or intersections. Such points must be treated as free points with estimated coordinates.
**Coordinate Estimation**: When some point coordinates are given, use them as anchors to scale and estimate the coordinates of free points proportionally (note that image y-axis points down while GeoGebra y-axis points up). All visible points in the diagram **must** be created.

---

## GeoGebra Command Reference (Follow Syntax Strictly)

**Points / Vectors**: `A = (x, y)`; polar `P = (5; 60°)`; `Intersect[a, b]`, `Intersect[a, b, n]`; `Midpoint[A, B]`; `Center[c]`; vector `v = (3, 4)`, `Vector[A, B]`.
**Lines**: `Segment[A, B]`, `Line[A, B]`, `Ray[A, B]`; equations `g: y = 2x + 1` / `g: 3x + 2y = 6`; `Perpendicular[A, line]`, `PerpendicularBisector[A, B]`, `AngleBisector[A, B, C]`.
**Functions**: `f(x) = x^2 + 2x + 1`; `sin/cos/tan`, `asin/acos/atan`; `exp(x)` or `e^x`; logarithms `ln(x)`, `lg(x)` (base 10, **do not** use `log(10,x)`), `ld(x)`; `sqrt/cbrt/abs/floor/ceil/round`; `If[x<0, -x, x]`; `Derivative[f]`, `Integral[f, a, b]`.
**Conics**: `Circle[M, r]`, `Circle[M, A]`, `Circle[A, B, C]`, equation `c: x^2 + y^2 = 9`; `Ellipse[F1, F2, a]` (use integer coefficients `9x^2 + 16y^2 = 144`, avoid fractions); `Hyperbola[F1, F2, a]`; `Parabola[F, line]`.
**Polygons / Angles**: `Polygon[A, B, C]`, `Polygon[A, B, n]` (regular n-gon); `Angle[A, B, C]`.
**Transformations**: `Translate / Rotate / Reflect / Dilate`.
**Styling**: `SetColor[obj, "Blue"]` or `SetColor[obj, r, g, b]`; `SetLineThickness[obj, 1-13]`; `SetLineStyle[obj, 0/1/2]`; `SetPointSize[obj, 1-9]`; `SetVisible[obj, false]` (hide auxiliary objects); `SetLabelVisible`, `SetCaption`.
**Canvas**: `ShowGrid[true/false]`, `ShowAxes[true/false]` (**do not** use `SetCoordSystem`, coordinate system auto-fits).
**Text**: `Text["content", (2,3)]`, LaTeX `Text["$\\frac{1}{2}$", (0,0)]`.

### Common Errors (Must Avoid)
- Using parentheses for command arguments: ❌ `Circle(A, 3)` / `Line(A, B)` -> ✅ Always use square brackets `Circle[A, 3]`, `Line[A, B]`.
- ❌ `Point({1,2})` -> ✅ `A = (1, 2)`.
- ❌ `log(10, x)` -> ✅ `lg(x)`.
- ❌ Equations with fractions `x^2/4 + y^2/9 = 1` -> ✅ Integer coefficients `9x^2 + 4y^2 = 36`.
- ❌ Using `#` for comments (GeoGebra does not support comments).
- ❌ Writing free diagram points as `Midpoint`/`Intersect`.

### Generation Sequence
Canvas setup -> Reference points (coordinates from text) -> Derived points (commands) -> Free points (estimated coordinates) -> Segments/Shapes -> Auxiliary constructions (hide with `SetVisible[..., false]`) -> Styling. Create objects before applying styles. Ensure all elements visible in the diagram are constructed.

---

## Output Format

**Output only a single JSON object** (optionally wrapped in a ```json code block), with the following structure, without any surrounding prose:

```json
{
  "image_is_reference": true,
  "image_reference_keywords": ["as shown in the figure"],
  "constraints": [
    {"description": "A has coordinates (-3, 0)", "type": "coordinate", "source": "text"}
  ],
  "geometric_relations": [
    {"type": "perpendicular", "objects": ["AC", "BD"], "description": "AC perpendicular to BD"}
  ],
  "commands": [
    {"command": "ShowAxes[true]", "description": "Show axes"},
    {"command": "A = (-3, 0)", "description": "Coordinate point A from text"},
    {"command": "B = (2, 0)", "description": "Coordinate point B from text"},
    {"command": "C = (-0.5, -3)", "description": "Free point C, estimated coordinates from figure"},
    {"command": "Segment[A, B]", "description": "Connect segment AB"}
  ]
}
```

`commands` must be non-empty and each item must be a valid GeoGebra command; `constraints` and `geometric_relations` may be empty arrays.
