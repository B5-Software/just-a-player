use egui::{Color32, Painter, Pos2, Rect, Shape, Stroke, vec2};

pub(crate) fn draw(id: &str, label: &str, painter: &Painter, center: Pos2, color: Color32) {
    let point = |x, y| center + vec2(x, y);
    let stroke = Stroke::new(1.65_f32, color);
    let line = |points: &[(f32, f32)]| {
        painter.add(Shape::line(
            points.iter().map(|&(x, y)| point(x, y)).collect(),
            stroke,
        ));
    };
    let triangle = |direction: f32| {
        painter.add(Shape::convex_polygon(
            vec![
                point(-5. * direction, -7.),
                point(7. * direction, 0.),
                point(-5. * direction, 7.),
            ],
            color,
            Stroke::NONE,
        ));
    };
    match id {
        "play" if label == "暂停" || label == "Pause" => {
            for x in [-5., 2.] {
                painter.rect_filled(
                    Rect::from_min_size(point(x, -7.), vec2(3.5, 14.)),
                    1.,
                    color,
                );
            }
        }
        "play" => triangle(1.),
        "previous" | "next" => {
            let d = if id == "previous" { -1. } else { 1. };
            triangle(d);
            painter.line_segment([point(8. * d, -7.), point(8. * d, 7.)], stroke);
        }
        "import" => line(&[
            (-9., -5.),
            (-3., -5.),
            (-1., -2.),
            (9., -2.),
            (7., 6.),
            (-9., 6.),
            (-9., -5.),
        ]),
        "settings" => {
            painter.circle_stroke(center, 3., stroke);
            let points = (0..=32)
                .map(|i| {
                    let angle = i as f32 / 32. * std::f32::consts::TAU;
                    let radius = if i % 4 == 1 || i % 4 == 2 { 8.5 } else { 6.5 };
                    point(angle.cos() * radius, angle.sin() * radius)
                })
                .collect();
            painter.add(Shape::line(points, stroke));
        }
        "reset" => {
            let points = (0..=20)
                .map(|i| {
                    let a = -2.5 + i as f32 * 0.27;
                    point(a.cos() * 7., a.sin() * 7.)
                })
                .collect();
            painter.add(Shape::line(points, stroke));
            line(&[(-8., -7.), (-6., -3.), (-2., -5.)]);
        }
        "radio" => {
            painter.circle_filled(center, 1.8, color);
            for radius in [5., 8.5] {
                for offset in [0., std::f32::consts::PI] {
                    let points = (0..=8)
                        .map(|i| {
                            let a = offset - 0.75 + i as f32 * 1.5 / 8.;
                            point(a.cos() * radius, a.sin() * radius)
                        })
                        .collect();
                    painter.add(Shape::line(points, stroke));
                }
            }
        }
        _ => {}
    }
}
