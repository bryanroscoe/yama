//! Image/rules fallback for newly revealed cards not yet in the weekly local catalog.
//! Only one public card name is sent through Yama's bounded, paced Scryfall cache.
use super::*;
use crate::mcp::research::client::Provider;
use serde_json::{Value, json};

#[derive(Deserialize)]
pub(super) struct Params { name: String }

pub(super) async fn get(State(st): State<AppState>, CurrentUser(user): CurrentUser, Query(p): Query<Params>) -> AppResult<Json<Value>> {
    st.limits.search.check_user(&user)?;
    let name=p.name.trim();
    if name.is_empty() || name.len()>240 || name.chars().any(char::is_control) {
        return Err(AppError::bad("Provide one card name."));
    }
    let document=st.research.get(Some(&user.id),Provider::Scryfall,"cards/named",&[("exact",name.to_string())]).await?;
    Ok(Json(preview(&document.json()?)))
}

fn preview(card: &Value) -> Value {
    let faces=card["card_faces"].as_array();
    let front=faces.and_then(|f|f.first()).unwrap_or(card);
    let image=|c:&Value| c["image_uris"]["normal"].as_str().or_else(||c["image_uris"]["grid"].as_str()).filter(|raw|url::Url::parse(raw).is_ok_and(|u|u.scheme()=="https"&&u.host_str()==Some("cards.scryfall.io"))).map(String::from);
    let text=faces.map(|f|f.iter().filter_map(|c|c["oracle_text"].as_str()).collect::<Vec<_>>().join("\n\n")).unwrap_or_else(||card["oracle_text"].as_str().unwrap_or_default().into());
    json!({"oracle_id":card["oracle_id"].as_str().unwrap_or_default(),"name":card["name"].as_str().unwrap_or_default(),
      "image_normal":image(card).or_else(||image(front)),"back_image_normal":faces.and_then(|f|f.get(1)).and_then(image),
      "oracle_text":text,"type_line":card["type_line"].as_str().unwrap_or_default(),"mana_cost":front["mana_cost"].as_str()})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn new_card_preview_supports_both_faces_and_trusted_images_only() {
        let data=json!({"oracle_id":"new","name":"Front // Back","type_line":"Creature // Land","card_faces":[
          {"oracle_text":"Front rules","mana_cost":"{G}","image_uris":{"normal":"https://cards.scryfall.io/normal/front.jpg"}},
          {"oracle_text":"Back rules","image_uris":{"grid":"https://cards.scryfall.io/grid/back.webp"}}]});
        let p=preview(&data);assert_eq!(p["image_normal"],"https://cards.scryfall.io/normal/front.jpg");assert_eq!(p["back_image_normal"],"https://cards.scryfall.io/grid/back.webp");assert_eq!(p["oracle_text"],"Front rules\n\nBack rules");
        let p=preview(&json!({"name":"Bad","image_uris":{"normal":"https://untrusted.invalid/a.jpg"}}));assert!(p["image_normal"].is_null());
    }
}
