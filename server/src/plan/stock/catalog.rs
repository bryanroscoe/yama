//! A complete public Shopify catalog, replaced atomically only after every page succeeds.
use super::*;
use flate2::read::GzDecoder;
use std::io::{Read, Write};

const MAX_BYTES: usize = 64 << 20;
const MAX_PAGES: usize = 1000;

fn locks() -> &'static std::sync::Mutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>> {
    static LOCKS: OnceLock<std::sync::Mutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(Default::default)
}

fn normalize_product(p: &Value) -> Option<Value> {
    let handle = p["handle"].as_str()?;
    if handle.is_empty() || !handle.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') || !text_ok(&p["title"]) { return None; }
    let variants = p["variants"].as_array()?;
    if variants.is_empty() { return None; }
    let mut normalized = Vec::new();
    for v in variants {
        let price = match &v["price"] { Value::String(s) => s.parse::<f64>().ok()?, x => x.as_f64()? };
        if !price.is_finite() || price < 0. || !v["available"].is_boolean() || !text_ok(&v["title"]) { return None; }
        let id = v["id"].as_u64().map(|n| n.to_string()).or_else(|| v["id"].as_str().map(String::from))?;
        if id.is_empty() || !id.bytes().all(|c| c.is_ascii_digit()) { return None; }
        normalized.push(json!({"id":id,"title":v["title"],"price":(price*100.).round(),"available":v["available"]}));
    }
    Some(json!({"handle":handle,"title":p["title"],"vendor":p["vendor"],"variants":normalized}))
}

async fn cached(pool: &SqlitePool, base: &str) -> Result<Option<(String,String,Vec<Value>)>, String> {
    let row: Option<(String,String,Vec<u8>)> = sqlx::query_as("SELECT fetched_at, completed_at, products_gz FROM store_catalog_cache WHERE base = ?")
        .bind(base).fetch_optional(pool).await.map_err(|e| e.to_string())?;
    let Some((at,completed,gz)) = row else { return Ok(None) };
    let mut bytes = Vec::new();
    GzDecoder::new(gz.as_slice()).take((MAX_BYTES+1) as u64).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES { return Err("Cached catalog exceeds its size limit".into()); }
    let products = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    Ok(Some((at,completed,products)))
}

pub(super) async fn products(pool: &SqlitePool, f: &mut Fetcher, base: &str, refresh: bool, requested: &str, raw: &mut Raw) -> Result<Option<(String,Vec<Value>)>,String> {
    if !refresh { return cached(pool,base).await.map(|row|row.map(|(at,_,products)|(at,products))); }
    let lock = locks().lock().expect("catalog locks").entry(base.to_string()).or_default().clone();
    let _guard = lock.lock().await;
    if let Some((at,completed,products)) = cached(pool,base).await.unwrap_or(None) {
        // A concurrent refresh that finished after this request already satisfies it.
        if !refresh || completed.as_str() >= requested { return Ok(Some((at,products))); }
    } else if !refresh { return Ok(None); }
    let fetched_at = now();
    let mut products = Vec::new();
    let mut handles = HashSet::new();
    let mut bytes = 0;
    let (was_refresh, was_first) = (f.refresh, f.first_429);
    f.refresh = true;
    f.first_429 = true;
    let result = tokio::time::timeout(Duration::from_secs(1800), async {
        for page in 1..=MAX_PAGES {
            let url = format!("{base}/products.json?limit=250&page={page}");
            let answer = f.send(Kind::Shopify,"GET",&url,None,raw).await?;
            let rows = answer["products"].as_array().ok_or("Catalog response has no product list")?;
            if rows.is_empty() {
                let encoded = serde_json::to_vec(&products).map_err(|e| e.to_string())?;
                let mut gz = GzEncoder::new(Vec::new(),Compression::default());
                gz.write_all(&encoded).map_err(|e| e.to_string())?;
                let gz = gz.finish().map_err(|e| e.to_string())?;
                sqlx::query("INSERT INTO store_catalog_cache(base,fetched_at,completed_at,product_count,products_gz) VALUES(?,?,?,?,?) ON CONFLICT(base) DO UPDATE SET fetched_at=excluded.fetched_at,completed_at=excluded.completed_at,product_count=excluded.product_count,products_gz=excluded.products_gz")
                    .bind(base).bind(&fetched_at).bind(now()).bind(products.len() as i64).bind(gz).execute(pool).await.map_err(|e|e.to_string())?;
                return Ok(Some((fetched_at,products)));
            }
            for row in rows {
                let product = normalize_product(row).ok_or("Unreadable catalog product or variant")?;
                let handle = product["handle"].as_str().ok_or("Missing handle")?.to_owned();
                if !handles.insert(handle) { return Err("Catalog pagination repeated a product; previous cache preserved".into()); }
                bytes += product.to_string().len()+1;
                if bytes > MAX_BYTES-2 { return Err("Catalog exceeds 64 MiB; previous cache preserved".into()); }
                products.push(product);
            }
        }
        Err("Catalog page limit reached; previous cache preserved".into())
    }).await.unwrap_or_else(|_| Err("Catalog refresh timed out after 30 minutes; previous cache preserved".into()));
    f.refresh = was_refresh;
    f.first_429 = was_first;
    result
}

pub async fn metadata(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Value>> {
    let mut catalogs = Vec::new();
    for (store,name,direct,_,_) in checkable(&st.pool,&user.id).await? {
        let Some((Kind::Shopify,base)) = direct else { continue };
        let row: Option<(String,String,i64)> = sqlx::query_as("SELECT fetched_at,completed_at,product_count FROM store_catalog_cache WHERE base = ?").bind(&base).fetch_optional(&st.pool).await?;
        catalogs.push(json!({"store":store,"name":name,"fetched_at":row.as_ref().map(|r| &r.0),"completed_at":row.as_ref().map(|r| &r.1),"products":row.as_ref().map(|r| r.2)}));
    }
    Ok(Json(json!({"catalogs":catalogs})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_prices_and_variants_keep_their_units_and_identity() {
        let p=json!({"handle":"card-a","title":"Card A [Set]","variants":[{"id":1,"title":"Near Mint","price":"1.75","available":true},{"id":2,"title":"Near Mint Foil","price":"2.00","available":true}]});
        let normalized=normalize_product(&p).unwrap();
        assert_eq!(normalized["variants"][0]["price"],175.0);
        assert_eq!(normalized["variants"][1]["title"],"Near Mint Foil");
        assert!(normalize_product(&json!({"handle":"bad/path","title":"A","variants":[]})).is_none());
    }
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    use axum::{Router, routing::get, extract::Query};
    use std::sync::{Arc, atomic::{AtomicBool, AtomicUsize, Ordering}};
    #[tokio::test]
    async fn reuse_and_failed_refresh_preserve_the_complete_catalog() {
        let (_,pool)=crate::testutil::app().await;
        let calls=Arc::new(AtomicUsize::new(0));
        let broken=Arc::new(AtomicBool::new(false));
        let (c,b)=(calls.clone(),broken.clone());
        let app=Router::new().route("/products.json",get(move |Query(q):Query<HashMap<String,String>>| {
            let (c,b)=(c.clone(),b.clone()); async move {
                c.fetch_add(1,Ordering::SeqCst);
                if b.load(Ordering::SeqCst) { return Json(json!({"error":"unreadable"})); }
                Json(if q.get("page").map(String::as_str)==Some("1") {json!({"products":[{"handle":"card-a","title":"Card A [Set]","variants":[{"id":1,"title":"Near Mint","price":"1.75","available":true}]}]})} else {json!({"products":[]})})
            }
        }));
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base=format!("http://{}",listener.local_addr().unwrap());
        let server=tokio::spawn(async move { axum::serve(listener,app).await.unwrap() });
        let mut f=Fetcher::new(reqwest::Client::new(),None);
        assert!(products(&pool,&mut f,&base,false,"",&mut Raw::default()).await.unwrap().is_none());
        let saved=products(&pool,&mut f,&base,true,"9999",&mut Raw::default()).await.unwrap().unwrap();
        assert_eq!(saved.1.len(),1);assert_eq!(calls.load(Ordering::SeqCst),2);
        broken.store(true,Ordering::SeqCst);
        let reused=products(&pool,&mut f,&base,false,"",&mut Raw::default()).await.unwrap().unwrap();
        assert_eq!(reused,saved);assert_eq!(calls.load(Ordering::SeqCst),2);
        assert!(products(&pool,&mut f,&base,true,"9999",&mut Raw::default()).await.is_err());
        assert_eq!(products(&pool,&mut f,&base,false,"",&mut Raw::default()).await.unwrap().unwrap(),saved);
        server.abort();
    }
}
