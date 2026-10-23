// Renders only inventory thumbnails through the game's own UI icon mapping.
// Data URLs stay in memory; no game textures are exported to the filesystem.
async function readItemIcons(items) {
    if (typeof Sprite_ItemIcon === 'undefined') throw new Error('游戏图标组件尚未就绪');
    const bitmaps = new Map();
    for (const item of items) {
        if (!bitmaps.has(item.type)) bitmaps.set(item.type,Sprite_ItemIcon.prototype.itemBitmap(item.type));
    }
    await Promise.all([...new Set(bitmaps.values())].map(bitmap=>new Promise((resolve,reject)=>{
        if (bitmap.isReady()) return resolve();
        if (bitmap.isError?.()) return reject(new Error('物品图标加载失败'));
        const timer=setTimeout(()=>reject(new Error('物品图标加载超时，请重试')),8000);
        bitmap.addLoadListener(()=>{ clearTimeout(timer); resolve(); });
    })));
    const icons = {};
    for (const item of items) {
        const bitmap = bitmaps.get(item.type);
        let frame;
        const proxy = { _type:item.type, bitmap, setFrame(x,y,width,height) { frame={x,y,width,height}; } };
        Sprite_ItemIcon.prototype.refreshIdx.call(proxy,item.id);
        const {x,y,width,height} = frame;
        if (![x,y,width,height].every(Number.isFinite) || width <= 0 || height <= 0 || width > 512 || height > 512 ||
            x < 0 || y < 0 || x+width > bitmap.width || y+height > bitmap.height) throw new Error('物品图标裁切范围无效');
        const canvas=document.createElement('canvas'); canvas.width=width; canvas.height=height;
        const context=canvas.getContext('2d'); context.imageSmoothingEnabled=false;
        context.drawImage(bitmap.canvas,x,y,width,height,0,0,width,height);
        icons[item.type+':'+item.id]=canvas.toDataURL('image/png');
    }
    return {ok:true,icons};
}
module.exports = { readItemIcons };
